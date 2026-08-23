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
  ToolCallInteraction,
  type NavigationGraphService,
} from "./NavigationGraphManager";
import { ProgressCallback } from "../../server/toolRegistry";
import { SmartNavigationHelper } from "./SmartNavigationHelper";
import type { PathOptimizer } from "./interfaces/PathOptimizer";
import { UIStateSetup } from "./interfaces/UIStateSetup";
import { DefaultUIStateSetup } from "./DefaultUIStateSetup";
import { ScreenTransitionWaiter } from "./interfaces/ScreenTransitionWaiter";
import { DefaultScreenTransitionWaiter } from "./DefaultScreenTransitionWaiter";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
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
      new DefaultScreenTransitionWaiter(this.navigationManager, NavigateTo.POLL_INTERVAL_MS);
  }

  /**
   * Execute navigation to the target screen.
   */
  async execute(
    options: NavigateToOptions,
    progress?: ProgressCallback,
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
      const currentNode = await this.navigationManager.getNode(currentScreen);
      const currentBackStackDepth = currentNode?.backStackDepth ?? 0;

      if (currentBackStackDepth > 0) {
        const backNavResult = await (
          this.pathOptimizer ?? SmartNavigationHelper
        ).shouldUseBackButton(currentScreen, targetScreen, currentBackStackDepth);

        if (backNavResult.shouldUseBack) {
          logger.info(
            `[NAVIGATE_TO] Using smart back button navigation: ` +
              `${backNavResult.backPresses} back presses. Reason: ${backNavResult.reason}`,
          );

          // Execute back button presses
          const executedPath: string[] = [];
          for (let i = 0; i < backNavResult.backPresses; i++) {
            if (progress) {
              await progress(
                i,
                backNavResult.backPresses,
                `Pressing back button (${i + 1}/${backNavResult.backPresses})`,
              );
            }

            await this.pressBack();
            executedPath.push("pressButton(back)");

            // Small delay between presses to allow screen transitions
            await this.timer.sleep(300);
          }

          // Wait for target screen
          const reached = await this.screenWaiter.waitForScreen(
            targetScreen,
            NavigateTo.STEP_TIMEOUT_MS,
          );

          if (progress) {
            await progress(
              backNavResult.backPresses,
              backNavResult.backPresses,
              reached ? `Arrived at ${targetScreen}` : `Waiting for ${targetScreen}`,
            );
          }

          perf.end();
          return {
            success: reached,
            message: reached
              ? `Successfully navigated to "${targetScreen}" using back button`
              : `Pressed back ${backNavResult.backPresses} times but did not reach "${targetScreen}"`,
            currentScreen: this.navigationManager.getCurrentScreen(),
            targetScreen,
            stepsExecuted: executedPath.length,
            path: executedPath,
            durationMs: this.timer.now() - startTime,
          };
        } else {
          logger.debug(
            `[NAVIGATE_TO] Not using back button navigation. Reason: ${backNavResult.reason}`,
          );
        }
      }

      // Find path to target
      const pathResult = await this.navigationManager.findPath(targetScreen);

      if (!pathResult.found) {
        perf.end();
        const knownScreens = await this.navigationManager.getKnownScreens();
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

      for (let i = 0; i < pathResult.path.length; i++) {
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
          await progress(i, pathResult.path.length, `Navigating: ${edge.from} → ${edge.to}`);
        }

        logger.info(
          `[NAVIGATE_TO] Step ${i + 1}/${pathResult.path.length}: ${edge.from} → ${edge.to}`,
        );

        // Execute navigation step
        try {
          if (edge.interaction) {
            // Set up scroll position if required (must happen before UI state setup)
            if (edge.uiState?.scrollPosition) {
              const scrollAction = await uiStateSetup.setupScrollPosition(
                edge.uiState.scrollPosition,
                options.platform,
              );
              if (scrollAction) {
                executedPath.push(scrollAction);
              }
            }

            // Set up required UI state before executing the tool call
            const setupActions = await uiStateSetup.setupUIState(edge, options.platform);
            if (setupActions.length > 0) {
              executedPath.push(...setupActions);
            }

            // Replay the tool call
            await this.executeToolCall(edge.interaction);
            executedPath.push(
              `${edge.interaction.toolName}(${JSON.stringify(edge.interaction.args)})`,
            );
          } else {
            // No known interaction - try back button
            logger.info(`[NAVIGATE_TO] No known interaction for edge, using back button`);
            await this.pressBack();
            executedPath.push("pressButton(back)");
          }
        } catch (error) {
          logger.warn(`[NAVIGATE_TO] Error executing step: ${error}`);
          perf.end();
          return {
            success: false,
            error: `Failed to execute step ${i + 1}: ${error}`,
            currentScreen: this.navigationManager.getCurrentScreen(),
            targetScreen,
            stepsExecuted: executedPath.length,
            partialPath: executedPath,
            durationMs: this.timer.now() - startTime,
          };
        }

        // Wait for screen transition
        const reached = await this.screenWaiter.waitForScreen(edge.to, NavigateTo.STEP_TIMEOUT_MS);
        if (!reached) {
          logger.warn(`[NAVIGATE_TO] Screen "${edge.to}" not reached within timeout`);
          // Continue anyway - navigation events might be delayed
        }
      }

      // Final progress update
      if (progress) {
        await progress(
          pathResult.path.length,
          pathResult.path.length,
          `Arrived at ${targetScreen}`,
        );
      }

      perf.end();
      return {
        success: true,
        message: `Successfully navigated to "${targetScreen}"`,
        currentScreen: this.navigationManager.getCurrentScreen(),
        targetScreen,
        stepsExecuted: executedPath.length,
        path: executedPath,
        durationMs: this.timer.now() - startTime,
      };
    } catch (error) {
      perf.end();
      return {
        success: false,
        error: `Navigation failed: ${error}`,
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
  private async executeToolCall(interaction: ToolCallInteraction): Promise<void> {
    logger.info(`[NAVIGATE_TO] Replaying tool call: ${interaction.toolName}`);

    // Replay through the internal-call seam (#3108): it resolves the tool,
    // marks the call internal (#3087), and invokes the handler in one step.
    // `callInternal` copies the args before marking, so the stored edge
    // `interaction.args` is never mutated. Under `--actions-diff-observe` this
    // replay neither diffs its observation nor advances the agent-facing diff
    // baseline. Throws ActionableError if the tool is not registered.
    const response = await ToolRegistry.callInternal(interaction.toolName, {
      ...(interaction.args as Record<string, unknown>),
      platform: this.device.platform,
      deviceId: this.device.deviceId,
      ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
    });
    throwIfInternalToolFailed(response, interaction.toolName, this.device.platform);
  }

  /**
   * Press the back button as a fallback navigation action.
   */
  private async pressBack(): Promise<void> {
    if (this.device.platform === "android") {
      // Keep the caller's injected ADB executor and timer for Android recovery.
      // PressButton retains the accessibility-service/ADB fallback without
      // observing, so this internal recovery does not advance any diff baseline.
      const result = await new PressButton(this.device, this.adb, this.timer).press("back");
      if (!result.success) {
        throw new Error(result.error ?? "Android back navigation failed");
      }
      logger.debug("[NAVIGATE_TO] Pressed back via Android interaction action");
      return;
    }

    // iOS has no injected host transport, so retain its internal tool routing
    // for the selected device and no-diff behavior.
    const response = await ToolRegistry.callInternal("pressButton", {
      button: "back",
      platform: this.device.platform,
      deviceId: this.device.deviceId,
      ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
    });
    throwIfInternalToolFailed(response, "pressButton", this.device.platform);
    logger.debug(`[NAVIGATE_TO] Pressed back via ${this.device.platform} interaction tool`);
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return this.timer.sleep(ms);
  }
}
