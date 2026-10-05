import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  stripNavigationToolParams,
} from "../../daemon/constants";
import { BootedDevice, NavigateToResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { ToolRegistry } from "../../server/toolRegistry";
import { throwIfInternalToolFailed } from "../../server/internalToolCall";
import {
  NavigationGraphManager,
  type NavigationEdge,
  type NavigationGraphService,
} from "./NavigationGraphManager";
import type { ToolCallInteraction } from "../../utils/interfaces/NavigationGraph";
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

  private static readonly MAX_TIMEOUT_MS = 30000; // 30 seconds
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
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.navigationManager = navigationManager ?? NavigationGraphManager.getInstance();
    this.timer = timer;
    this.pathOptimizer = pathOptimizer;
    this.sessionUuid = sessionUuid;

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
        return {
          success: false,
          error: "Cannot determine current screen. No navigation events recorded yet.",
          currentScreen: null,
          targetScreen,
          stepsExecuted: 0,
        };
      }

      // Already on target screen
      if (currentScreen === targetScreen) {
        perf.end();
        return {
          success: true,
          message: "Already on target screen",
          currentScreen,
          targetScreen,
          stepsExecuted: 0,
          durationMs: this.timer.now() - startTime,
        };
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
        return {
          success: false,
          error:
            `No known path from "${currentScreen}" to "${targetScreen}". ` +
            `Known screens: ${knownScreens.join(", ") || "none"}`,
          currentScreen,
          targetScreen,
          stepsExecuted: 0,
          durationMs: this.timer.now() - startTime,
        };
      }

      // Execute path
      const executedPath: string[] = [];
      let reached = false;
      let arrivalScreen: string | undefined;

      for (let i = 0; i < pathResult.path.length; i++) {
        throwIfAborted(signal);
        const edge = pathResult.path[i];

        // Check timeout
        if (this.timer.now() - startTime > NavigateTo.MAX_TIMEOUT_MS) {
          perf.end();
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

        // Report progress
        if (progress) {
          await awaitWhileRequestIsLive(
            progress(i, pathResult.path.length, `Navigating: ${edge.from} → ${edge.to}`),
            signal,
          );
        }

        logger.info(
          `[NAVIGATE_TO] Step ${i + 1}/${pathResult.path.length}: ${edge.from} → ${edge.to}`,
        );

        // Execute navigation step
        try {
          await this.replayStep(edge, options, uiStateSetup, executedPath, signal);
        } catch (error) {
          throwIfAborted(signal);
          logger.warn(`[NAVIGATE_TO] Error executing step: ${errorMessage(error)}`, error);
          perf.end();
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
          perf.end();
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
      }

      // Final progress update
      if (progress) {
        await awaitWhileRequestIsLive(
          progress(
            pathResult.path.length,
            pathResult.path.length,
            reached ? `Arrived at ${targetScreen}` : `Waiting for ${targetScreen}`,
          ),
          signal,
        );
      }

      throwIfAborted(signal);
      perf.end();
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
    } catch (error) {
      perf.end();
      throwIfAborted(signal);
      logger.warn(`[NAVIGATE_TO] Navigation failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        error: `Navigation failed: ${errorMessage(error)}`,
        currentScreen: this.navigationManager.getCurrentScreen(),
        targetScreen,
        stepsExecuted: 0,
        durationMs: this.timer.now() - startTime,
      };
    }
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

  private async replayStep(
    edge: NavigationEdge,
    options: NavigateToOptions,
    uiStateSetup: UIStateSetup,
    executedPath: string[],
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
      await this.executeToolCall(interaction, options, signal);
      executedPath.push(`${edge.interaction.toolName}(${JSON.stringify(interaction.args)})`);
    } else {
      // No known interaction - try back button
      logger.info(`[NAVIGATE_TO] No known interaction for edge, using back button`);
      await this.pressBack(signal);
      executedPath.push("pressButton(back)");
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
