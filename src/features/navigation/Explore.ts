import { DEFAULT_EXPLORE_TIMEOUT_MS } from "./exploreTimeout";
export { DEFAULT_EXPLORE_TIMEOUT_MS } from "./exploreTimeout";
import { beginPostActionCaptureAction } from "../../utils/PostActionCaptureContext";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice, Element, isTruthy, ObserveResult } from "../../models";
import { BaseVisualChange, ProgressCallback } from "../action/BaseVisualChange";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { logger } from "../../utils/logger";
import { ToolRegistry } from "../../server/toolRegistry";
import { throwIfInternalToolFailed } from "../../server/internalToolCall";
import {
  NavigationGraphManager,
  type NavigationEdge,
  type NavigationGraphService,
} from "./NavigationGraphManager";
import { ExportedGraph } from "../../utils/interfaces/NavigationGraph";
import { UIStateExtractor } from "./UIStateExtractor";
import { TapAtCoordinate } from "../action/TapAtCoordinate";
import { TapOnElement } from "../action/TapOnElement";
import { SwipeOnElement } from "../action/SwipeOnElement";
import { PressButton } from "../action/PressButton";
import { LaunchApp } from "../action/LaunchApp";
import { DefaultElementParser } from "../utility/ElementParser";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { throwIfAborted } from "../../utils/toolUtils";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

// Re-export consumed types
export type { ExploreOptions } from "./ExploreTypes";

// Import types
import type {
  ExplorationMode,
  ExplorationStrategy,
  ExploreOptions,
  ExploreResult,
  ExploreDryRunResult,
  ExploreExecutionResult,
  ElementSelectionStats,
  TrackedElement,
  GraphTraversalState,
} from "./ExploreTypes";

// Import element extraction functions
import {
  extractNavigationElements,
  extractScrollableContainers,
  extractAllElements,
  getElementKey,
  filterUnexhaustedElements,
  tapSelectorFor,
  tapCoordinatesFor,
  publicTapOnArgs,
} from "./ExploreElementExtraction";

// Import element scoring functions
import {
  selectBreadthFirst,
  selectDepthFirst,
  selectWeighted,
  rankElementsForDryRun,
  getElementTarget,
  predictOutcomeForElement,
} from "./ExploreElementScoring";

// Import blocker detection functions
import {
  detectAndHandleBlockers,
  filterPermissionNavigationCandidates,
  isPermissionDialog,
  isConfirmedPermissionDialogForNavigation,
  handlePermissionDialog,
} from "./ExploreBlockerDetection";
import type { BlockerHandlerDeps, DialogTapActionFactory } from "./ExploreBlockerDetection";

// Import validate mode functions
import {
  initializeGraphTraversal,
  markNodeVisited,
  markEdgeTraversed,
  selectNextEdgeToTraverse,
  resolveEdgeTarget,
  markEdgeSkipped,
  validateNavigation,
} from "./ExploreValidateMode";

export const DEFAULT_MAX_INTERACTIONS = 200;

interface ExplorationLoopContext {
  options: ExploreOptions;
  maxInteractions: number;
  timeoutMs: number;
  startTime: number;
  strategy: ExplorationStrategy;
  mode: ExplorationMode;
  resetInterval: number;
  initialNodeCount: number;
  perf: PerformanceTracker;
  progress?: ProgressCallback;
  signal?: AbortSignal;
}

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
  private consecutiveNoChangeCount: number = 0;
  private permissionDialogIdentity: string | null = null;
  private permissionDialogTapAttempts: number = 0;
  private loopDetection: Map<string, number> = new Map();
  private elementParser: ElementParser;
  private stopReason: string = "";
  private previousScreen: string | null = null;
  private targetPackageName: string | null = null;
  private consecutiveOutOfAppCount: number = 0;
  private readonly rootScreens: Set<string> = new Set();
  private pendingBackScreen: string | null = null;
  private awaitingRelaunchScreen: boolean = false;
  private hasObservedTargetApp: boolean = false;
  /** @internal Exposed for focused traversal report tests. */
  graphTraversalState: GraphTraversalState | null = null;
  private currentTargetEdge: NavigationEdge | null = null;
  /** Validate mode: the recorded Back edge selected for the next iteration (no element to tap). */
  private recordedBackEdge: NavigationEdge | null = null;
  private currentElementConfidence: number = 0;
  private sessionUuid?: string;
  private readonly tapActionFactory?: DialogTapActionFactory;

  // Constants for safety limits
  private static readonly MAX_CONSECUTIVE_BACKS = 5;
  private static readonly MAX_CONSECUTIVE_NO_CHANGE = 40;
  private static readonly MAX_PERMISSION_DIALOG_TAP_ATTEMPTS = 3;
  private static readonly MAX_LOOP_ITERATIONS = 3;
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
    }
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
    this.permissionDialogIdentity = null;
    this.permissionDialogTapAttempts = 0;
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
    const { progress } = context;
    if (!this.recordedBackEdge) {
      logger.info("[Explore] No suitable element found, checking dead-end recovery");
      await this.handleDeadEnd(progress, observation);
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
          null,
          false,
          this.timer,
          "Back press failed",
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
    const permissionOutcome = await this.handlePermissionDialogFastPath(observation, progress);
    if (permissionOutcome === "break") {
      return "break";
    }
    if (permissionOutcome === "continue") {
      return "continue";
    }

    if (!this.targetPackageName) {
      this.targetPackageName = this.getObservationPackageName(observation);
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
      (p) => this.handleDeadEnd(p),
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
    if (options.resetToHome && this.isResetDue(resetInterval)) {
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
    const strategy = options.strategy ?? "weighted";
    const mode = options.mode ?? "hybrid";
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

    const warnings: string[] = [];

    const observation = await this.observeScreen.execute({ perf, skipWaitForFresh: true, signal });
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy || viewHierarchy.hierarchy.error) {
      warnings.push("Unable to inspect view hierarchy for dry run planning.");
      return {
        success: true,
        dryRun: true,
        currentScreen: {
          name: "unknown",
          interactableElements: 0,
        },
        plannedInteractions: [],
        estimatedCoverage: {
          screensToVisit: [],
          newScreensExpected: 0,
          existingScreensToRevisit: 0,
        },
        warnings,
        observation,
        durationMs: this.timer.now() - startTime,
      };
    }

    const currentPackage = this.getObservationPackageName(observation);
    if (this.targetPackageName && currentPackage && this.targetPackageName !== currentPackage) {
      warnings.push(
        `Foreground package '${currentPackage}' does not match target '${this.targetPackageName}'.`,
      );
    }

    const currentScreen = this.navigationManager.getCurrentScreen() ?? "unknown";
    const edges =
      currentScreen !== "unknown" ? await this.navigationManager.getEdgesFrom(currentScreen) : [];

    const navigationElements = extractNavigationElements(viewHierarchy, this.elementParser);
    const scrollableContainers = extractScrollableContainers(viewHierarchy, this.elementParser);
    const allCandidates = [...navigationElements, ...scrollableContainers];
    const safeCandidates = filterPermissionNavigationCandidates(
      allCandidates,
      extractAllElements(viewHierarchy, this.elementParser),
    );

    if (safeCandidates.length === 0) {
      warnings.push("No interactable elements were detected on the current screen.");
    }

    const scored = rankElementsForDryRun(safeCandidates, strategy, mode, this.exploredElements);
    const plannedInteractions = scored.slice(0, maxInteractions).map((entry, index) => {
      const target = getElementTarget(entry.element);
      const predictedOutcome = predictOutcomeForElement(entry.element, edges);

      return {
        order: index + 1,
        action: entry.action,
        target,
        reason: entry.reason,
        predictedOutcome,
        whitelistStatus: entry.whitelistStatus,
      };
    });

    const predictedScreens = plannedInteractions
      .map((interaction) => interaction.predictedOutcome.screen)
      .filter((screen) => screen && screen !== "unknown");
    const uniqueScreens = Array.from(new Set(predictedScreens));
    const knownScreens = await this.navigationManager.getKnownScreens();
    const knownScreenSet = new Set(knownScreens);

    const newScreensExpected = uniqueScreens.filter((screen) => !knownScreenSet.has(screen)).length;
    const existingScreensToRevisit = uniqueScreens.filter((screen) =>
      knownScreenSet.has(screen),
    ).length;

    if (currentScreen === "unknown") {
      warnings.push("Current screen is unknown; outcome predictions may be limited.");
    } else if (edges.length === 0) {
      warnings.push("No navigation edges recorded for the current screen.");
    }

    perf.end();
    return {
      success: true,
      dryRun: true,
      currentScreen: {
        name: currentScreen,
        interactableElements: safeCandidates.length,
      },
      plannedInteractions,
      estimatedCoverage: {
        screensToVisit: uniqueScreens,
        newScreensExpected,
        existingScreensToRevisit,
      },
      warnings,
      observation,
      durationMs: this.timer.now() - startTime,
    };
  }

  /**
   * Detect and act on a permission dialog at the top of the exploration loop.
   *
   * Returns:
   * - `"continue"` when the dialog was granted (screen changed) or the no-op of
   *   an ungrantable dialog was accounted for and the loop should re-observe;
   * - `"break"` when an ungrantable (e.g. deny-only) dialog has stalled the
   *   screen long enough to trip the stuck-screen accounting;
   * - `"none"` when no permission dialog is present.
   *
   * A dialog exposing no safe affirmative control (e.g. only "Don't allow") can
   * neither be granted nor have its deny control tapped (issue #6241). The
   * previous fast-path discarded that outcome and always continued, so
   * exploration re-observed the same unchanged dialog until the timeout. Counting
   * the no-op lets the existing stuck-screen accounting stop the run instead
   * (partially addresses issue #6169).
   */
  private async handlePermissionDialogFastPath(
    observation: ObserveResult,
    progress?: ProgressCallback,
  ): Promise<"continue" | "break" | "none"> {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy || viewHierarchy.hierarchy.error) {
      return "none";
    }
    const elements = extractAllElements(viewHierarchy, this.elementParser);
    if (!isPermissionDialog(elements) || !isConfirmedPermissionDialogForNavigation(elements)) {
      return "none";
    }

    const identity = elements
      .filter((element) => isTruthy(element.clickable))
      .map((element) => getElementKey(element, viewHierarchy))
      .sort()
      .join("|");
    if (identity !== this.permissionDialogIdentity) {
      this.permissionDialogIdentity = identity;
      this.permissionDialogTapAttempts = 0;
    }
    if (this.permissionDialogTapAttempts >= Explore.MAX_PERMISSION_DIALOG_TAP_ATTEMPTS) {
      this.consecutiveNoChangeCount++;
      logger.warn(
        `[Explore] Permission dialog tap cap reached for identity "${identity}" ` +
          `(${this.permissionDialogTapAttempts}/${Explore.MAX_PERMISSION_DIALOG_TAP_ATTEMPTS})`,
      );
      if (this.shouldBreakForSafety(observation)) {
        logger.warn("[Explore] Unresolvable permission dialog treated as blocker, stopping");
        return "break";
      }
      return "continue";
    }
    this.permissionDialogTapAttempts++;

    logger.info("[Explore] Detected permission dialog, attempting to dismiss");
    const granted = await handlePermissionDialog(
      elements,
      viewHierarchy,
      this.device,
      this.adb,
      progress,
      this.blockerHandlerDeps(),
    );
    if (granted) {
      this.consecutiveNoChangeCount = 0;
      return "continue";
    }

    this.consecutiveNoChangeCount++;
    logger.warn(
      `[Explore] Permission dialog could not be granted (deny-only); counted as no-op ` +
        `(${this.consecutiveNoChangeCount}/${Explore.MAX_CONSECUTIVE_NO_CHANGE})`,
    );
    if (this.shouldBreakForSafety(observation)) {
      logger.warn("[Explore] Unresolvable permission dialog treated as blocker, stopping");
      return "break";
    }
    return "continue";
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
    // Check for consecutive backs
    if (this.consecutiveBackCount >= Explore.MAX_CONSECUTIVE_BACKS) {
      this.stopReason = `Too many consecutive back navigations (${Explore.MAX_CONSECUTIVE_BACKS})`;
      logger.warn(`[Explore] ${this.stopReason}`);
      return true;
    }

    // Check for screen stuck (no changes)
    if (this.consecutiveNoChangeCount >= Explore.MAX_CONSECUTIVE_NO_CHANGE) {
      this.stopReason = `Screen appears stuck - no changes detected after ${Explore.MAX_CONSECUTIVE_NO_CHANGE} interactions`;
      logger.warn(`[Explore] ${this.stopReason}`);
      return true;
    }

    // Check for loops
    const currentScreen = this.navigationManager.getCurrentScreen();
    if (currentScreen) {
      const loopCount = this.loopDetection.get(currentScreen) ?? 0;
      if (loopCount >= Explore.MAX_LOOP_ITERATIONS) {
        this.stopReason = `Detected navigation loop on screen: ${currentScreen}`;
        logger.warn(`[Explore] ${this.stopReason}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Select the next element to interact with based on strategy
   */
  private async selectNextElement(
    observation: ObserveResult,
    strategy: ExplorationStrategy,
    mode: ExplorationMode,
    perf: PerformanceTracker,
  ): Promise<Element | null> {
    return await perf.track("selectNextElement", async () => {
      this.recordedBackEdge = null;
      const viewHierarchy = observation.viewHierarchy;
      const safeCandidates = this.getSafeExplorationCandidates(observation);

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

      // Filter out exhausted elements
      const currentScreen = this.navigationManager.getCurrentScreen();
      const unexhaustedElements = filterUnexhaustedElements(
        safeCandidates,
        this.exploredElements,
        currentScreen,
        viewHierarchy,
      );

      if (unexhaustedElements.length === 0) {
        return null;
      }

      // Select based on strategy
      switch (strategy) {
        case "breadth-first":
          return selectBreadthFirst(unexhaustedElements);
        case "depth-first":
          return selectDepthFirst(unexhaustedElements, this.exploredElements);
        case "weighted":
        default: {
          const result = selectWeighted(unexhaustedElements, mode, this.exploredElements);
          if (result) {
            // Record selection stats
            this.elementSelections.push(result.stats);
            return result.element;
          }
          return null;
        }
      }
    });
  }

  private getSafeExplorationCandidates(observation: ObserveResult): Element[] {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy || viewHierarchy.hierarchy.error) {
      return [];
    }

    const navigationElements = extractNavigationElements(viewHierarchy, this.elementParser);
    const scrollableContainers = extractScrollableContainers(viewHierarchy, this.elementParser);
    // Retain the permission fast-path's conservative deny-label policy at selection.
    return filterPermissionNavigationCandidates(
      [...navigationElements, ...scrollableContainers],
      extractAllElements(viewHierarchy, this.elementParser),
    );
  }

  private selectValidateElement(candidates: Element[]): Element | null {
    const state = this.graphTraversalState;
    if (!state) {
      return null;
    }
    const currentScreen = this.navigationManager.getCurrentScreen() ?? "unknown";
    if (currentScreen !== "unknown") {
      markNodeVisited(state, currentScreen);
    }

    // Each skipped edge leaves the pending set, so this terminates.
    for (;;) {
      const targetEdge = selectNextEdgeToTraverse(state, currentScreen);
      if (!targetEdge) {
        if (state.pendingEdges.size === 0) {
          this.stopReason = "All edges in navigation graph have been traversed";
          logger.info(`[Explore] ${this.stopReason}`);
        }
        // Pending sources elsewhere: let the loop use its bounded back recovery.
        return null;
      }

      const resolution = resolveEdgeTarget(candidates, targetEdge);
      if (resolution.status === "not-validatable") {
        // A property of the recorded edge, not of the app: skip it and try the next one.
        markEdgeSkipped(state, targetEdge, resolution.reason, this.timer);
        continue;
      }
      if (resolution.status === "back") {
        // Nothing to tap: the loop replays this edge with the Back button.
        this.currentTargetEdge = targetEdge;
        this.currentElementConfidence = 1;
        this.recordedBackEdge = targetEdge;
        return null;
      }
      if (resolution.status === "not-found") {
        this.stopReason =
          `Validate mode: Cannot find element matching edge ${targetEdge.from}->${targetEdge.to}. ` +
          `App may have diverged from known graph.`;
        logger.error(`[Explore] ${this.stopReason}`);
        markEdgeTraversed(
          state,
          targetEdge,
          null,
          false,
          this.timer,
          "Element not found on screen",
        );
        return null;
      }
      return this.targetValidateEdge(targetEdge, resolution);
    }
  }

  private targetValidateEdge(
    targetEdge: NavigationEdge,
    match: { element: Element; confidence: number },
  ): Element {
    logger.info(
      `[Explore] Validate mode: targeting edge ${targetEdge.from}->${targetEdge.to} ` +
        `(confidence: ${(match.confidence * 100).toFixed(0)}%)`,
    );
    this.currentTargetEdge = targetEdge;
    this.currentElementConfidence = match.confidence;
    return match.element;
  }

  private getObservationPackageName(observation: ObserveResult): string | null {
    const packageName =
      observation.viewHierarchy?.packageName ?? observation.activeWindow?.appId ?? null;

    if (!packageName) {
      return null;
    }

    const trimmed = packageName.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async enforceTargetApp(
    observation: ObserveResult,
    targetPackageName: string,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<"ok" | "handled" | "stop"> {
    const currentPackage = this.getObservationPackageName(observation);

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
    await this.timer.sleep(1000);

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
    const hasInAppParent = incomingEdges.some(
      (edge) => edge.from !== currentScreen && edge.edgeType !== "back",
    );
    if (!hasInAppParent) {
      this.rootScreens.add(currentScreen);
    }
  }

  /**
   * Perform interaction with selected element
   */
  private async performInteraction(
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
    logger.info(
      `[Explore] Swiping on scrollable container: ${element["resource-id"] || element["class"]}`,
    );
    const swipeOn = new SwipeOnElement(this.device, this.adb);
    const container = observation.viewHierarchy
      ? tapSelectorFor(element, observation.viewHierarchy)
      : null;
    const result = await this.runRecorded(
      container ? "swipeOn" : null,
      container ? { container, direction: "up", speed: "slow" } : {},
      observation,
      () =>
        swipeOn.execute(
          element,
          "up",
          { duration: 600 }, // Slow swipe
          progress,
          signal,
        ),
    );
    return result.success;
  }

  /** Tap an element by selector, else its centre; null when it has no tap target. */
  private async tapElement(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    const selector = observation.viewHierarchy
      ? tapSelectorFor(element, observation.viewHierarchy)
      : null;
    const coordinates = selector ? null : tapCoordinatesFor(element);
    if (!selector && !coordinates) {
      logger.warn(
        `[Explore] Element has no tap target: missing resource-id, text/content-desc (including descendants), and usable bounds; class=${element["class"] || "<empty>"}; bounds=${JSON.stringify(element.bounds)}`,
      );
      return null;
    }
    const result = selector
      ? await this.runRecorded("tapOn", publicTapOnArgs(selector), observation, () =>
          new TapOnElement(this.device, this.adb).execute(
            { ...selector, action: "tap" },
            progress,
            signal,
          ),
        )
      : await this.runRecorded("tapAt", { ...coordinates!, action: "tap" }, observation, () =>
          new TapAtCoordinate(this.device, this.adb, { timer: this.timer }).execute(
            { ...coordinates!, action: "tap" },
            progress,
            signal,
          ),
        );
    return result.success;
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
    const withdraw = toolName
      ? this.navigationManager.recordToolCall(
          toolName,
          args,
          new UIStateExtractor().extractFromObservation(observation),
        )
      : undefined;
    let succeeded = false;
    try {
      const result = await run();
      succeeded = result.success;
      return result;
    } finally {
      if (!succeeded) {
        withdraw?.();
      }
    }
  }

  /**
   * Press Back on the device, recorded as `pressButton { button: "back" }` so the
   * edge the resulting navigation creates replays (and validates) as a recorded
   * Back instead of an unknown interaction.
   */
  private async dispatchBack(observation?: ObserveResult): Promise<void> {
    // Recovery dispatches below bypass BaseVisualChange's action boundary.
    await beginPostActionCaptureAction();
    await this.runRecorded("pressButton", { button: "back" }, observation, async () => {
      await this.pressBackOnPlatform();
      return { success: true };
    });
  }

  private async pressBackOnPlatform(): Promise<void> {
    if (this.device.platform === "android") {
      // Preserve the Explore instance's injected transport and timer. Calling
      // press() avoids nested observed-interaction progress on this operation.
      const result = await new PressButton(this.device, this.adb, this.timer).press("back");
      if (!result.success) {
        throw new Error(result.error ?? "Android back navigation failed");
      }
      return;
    }
    // iOS recovery must route through the selected device/session tool.
    // Do not forward the outer progress callback: the nested action has a
    // different scale and would make exploration progress jump backward.
    const response = await ToolRegistry.callInternal("pressButton", {
      button: "back",
      platform: this.device.platform,
      deviceId: this.device.deviceId,
      ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
    });
    throwIfInternalToolFailed(response, "pressButton", this.device.platform);
  }

  /**
   * Handle dead-end situation by going back
   */
  private async handleDeadEnd(
    progress?: ProgressCallback,
    observation?: ObserveResult,
  ): Promise<void> {
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

      await this.dispatchBack(observation);
      this.pendingBackScreen = currentScreen === "unknown" ? null : currentScreen;
      this.consecutiveBackCount++;

      // Wait briefly for navigation
      await this.timer.sleep(1000);
    } catch (error) {
      logger.warn(`[Explore] Failed to navigate back: ${error}`);
      this.stopReason = `Back-navigation recovery failed: ${errorMessage(error)}`;
    }
  }

  /**
   * Reset to home screen
   */
  private async resetToHome(progress?: ProgressCallback, signal?: AbortSignal): Promise<void> {
    try {
      if (progress) {
        await progress(
          this.interactionCount,
          this.interactionCount + 1,
          "Resetting to home screen...",
        );
      }

      // Recovery dispatches below bypass BaseVisualChange's action boundary.
      await beginPostActionCaptureAction();
      if (this.device.platform === "android") {
        // PressButton's Android home path retains the injected ADB/timer and
        // performs the same accessibility-service then ADB fallback. Forward
        // Explore's AbortSignal (not just a remaining timeout) so a cancelled
        // exploration aborts the home dispatch and foreground-verification reads
        // rather than running them to completion (issue #6289).
        const result = await new PressButton(this.device, this.adb, this.timer).press(
          "home",
          undefined,
          undefined,
          signal,
        );
        if (!result.success) {
          throw new Error(result.error ?? "Android home navigation failed");
        }
      } else {
        // Keep iOS recovery session/device-aware without nested progress.
        const response = await ToolRegistry.callInternal("homeScreen", {
          platform: this.device.platform,
          deviceId: this.device.deviceId,
          ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        });
        throwIfInternalToolFailed(response, "homeScreen", this.device.platform);
      }

      // Wait for home screen
      await this.timer.sleep(2000);

      // Home alone leaves the launcher in the foreground, which the next
      // observation would treat as having left the target app (issue #6126).
      if (this.targetPackageName) {
        await this.relaunchTargetApp(this.targetPackageName, signal);
      }

      // Reset consecutive back count
      this.consecutiveBackCount = 0;
    } catch (error) {
      logger.warn(`[Explore] Failed to reset to home: ${error}`);
      this.stopReason = `Home-screen recovery failed: ${errorMessage(error)}`;
    }
  }

  /**
   * A periodic reset is due once per resetInterval successful interactions.
   * interactionCount only advances on success, so the modulo check alone would
   * re-fire on every iteration the count sits on a multiple, including 0
   * before anything was explored (issue #6126).
   */
  private isResetDue(resetInterval: number): boolean {
    return (
      this.interactionCount > 0 &&
      this.interactionCount !== this.lastResetAt &&
      this.interactionCount % resetInterval === 0
    );
  }

  /**
   * Bring the target app back to the foreground after a home reset or app exit.
   *
   * This is a plain warm launchApp on purpose (no clearAppData, no coldBoot):
   * it recovers the foreground (issue #6126) with the platform's cheapest
   * launch. What "warm" means is launchApp's contract per platform — Android
   * and the iOS simulator foreground the existing process, while a physical
   * iOS device relaunches it because devicectl has no foreground verb.
   */
  private async relaunchTargetApp(packageName: string, signal?: AbortSignal): Promise<void> {
    if (this.device.platform === "android") {
      // Same injected transport and timer as the home press above.
      const result = await new LaunchApp(this.device, this.adb, null, this.timer).execute(
        packageName,
        false,
        false,
        undefined,
        undefined,
        undefined,
        signal,
      );
      if (!result.success) {
        throw new Error(result.error ?? `Android relaunch of ${packageName} failed`);
      }
    } else {
      // Keep iOS recovery session/device-aware without nested progress.
      const response = await ToolRegistry.callInternal(
        "launchApp",
        {
          appId: packageName,
          platform: this.device.platform,
          deviceId: this.device.deviceId,
          ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        },
        undefined,
        signal,
      );
      throwIfInternalToolFailed(response, "launchApp", this.device.platform);
    }
    // Only an initial launch with no target-app observation can establish a
    // fresh-start root. Later warm launches may resume any screen in the task.
    this.awaitingRelaunchScreen = !this.hasObservedTargetApp;
  }

  private traversalStopReason(): string {
    const reason = this.stopReason || "Exploration completed successfully";
    const state = this.graphTraversalState;
    if (!state || state.pendingEdges.size === 0) {
      return reason;
    }

    const results = Array.from(state.edgeValidationResults.values());
    const validated = results.filter((result) => result.success).length;
    const skipped = results.filter((result) => result.skipped).length;
    const failed = results.length - validated - skipped;
    const skippedNote = skipped > 0 ? `${skipped} skipped (not replayable); ` : "";
    const pending = Array.from(
      state.pendingEdges,
      ([key, edge]) => `${edge.from}->${edge.to} (${key})`,
    );
    // A budget/safety stop proves these were not reached in this run, not that
    // they are globally unreachable. Preserve its reason alongside the remainder.
    return (
      `${reason}. Validated ${validated} of ${state.totalEdgesInGraph} edges; ` +
      `${failed} failed validation; ${skippedNote}${state.pendingEdges.size} remain pending. ` +
      `Pending edges not reached before stopping (source->destination): ${pending.join(", ")}`
    );
  }

  /**
   * Generate final report
   */
  private async generateReport(
    initialGraph: ExportedGraph,
    startTime: number,
    cancelled: boolean,
  ): Promise<ExploreResult> {
    const finalGraph = initialGraph.appId
      ? await this.navigationManager.exportGraphForApp(initialGraph.appId)
      : await this.navigationManager.exportGraph();
    const screensDiscovered = Math.max(0, finalGraph.nodes.length - initialGraph.nodes.length);
    const edgesAdded = Math.max(0, finalGraph.edges.length - initialGraph.edges.length);

    // Calculate coverage
    const totalScreens = finalGraph.nodes.length;
    const exploredScreens = new Set(this.explorationPath).size;
    const coveragePercentage = totalScreens > 0 ? (exploredScreens / totalScreens) * 100 : 0;

    // Build graph traversal metrics if in validate mode
    let graphTraversal: ExploreResult["graphTraversal"];
    if (this.graphTraversalState) {
      const traversalCoverage =
        this.graphTraversalState.totalEdgesInGraph > 0
          ? (this.graphTraversalState.traversedEdges.size /
              this.graphTraversalState.totalEdgesInGraph) *
            100
          : 0;

      graphTraversal = {
        nodesVisited: this.graphTraversalState.visitedNodes.size,
        totalNodes: this.graphTraversalState.totalNodesInGraph,
        edgesTraversed: this.graphTraversalState.traversedEdges.size,
        totalEdges: this.graphTraversalState.totalEdgesInGraph,
        edgeValidationResults: Array.from(this.graphTraversalState.edgeValidationResults.values()),
        coveragePercentage: Math.round(traversalCoverage * 100) / 100,
      };
    }

    return {
      success: true,
      cancelled,
      interactionsPerformed: this.interactionCount,
      screensDiscovered,
      edgesAdded,
      navigationGraph: finalGraph,
      explorationPath: this.explorationPath,
      coverage: {
        totalScreens,
        exploredScreens,
        percentage: Math.round(coveragePercentage * 100) / 100,
      },
      elementSelections: this.elementSelections,
      durationMs: this.timer.now() - startTime,
      stopReason: this.traversalStopReason(),
      graphTraversal,
    };
  }
}
