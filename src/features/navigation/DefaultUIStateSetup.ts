import { BootedDevice } from "../../models";
import { ObserveResult } from "../../models/ObserveResult";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { ToolRegistry } from "../../server/toolRegistry";
import { markInternalToolCall } from "../../server/internalToolCall";
import { NavigationEdge, UIState } from "./NavigationGraphManager";
import { ModalState, ScrollPosition } from "../../utils/interfaces/NavigationGraph";
import { UIStateExtractor } from "./UIStateExtractor";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { getStructuredField } from "../../utils/toolUtils";
import { UIStateSetup } from "./interfaces/UIStateSetup";
import { defaultTimer, Timer } from "../../utils/SystemTimer";

/**
 * Default implementation of UIStateSetup that handles UI state alignment
 * before navigation steps.
 */
/**
 * Minimal observe seam so UI-state setup can be unit-tested without driving a
 * real ObserveScreen (WebSocket / device I/O).
 */
export interface ObserveScreenLike {
  execute(): Promise<ObserveResult>;
}

export class DefaultUIStateSetup implements UIStateSetup {
  private device: BootedDevice;
  private adb: AdbClient;
  private observeScreenProvider: () => ObserveScreenLike;
  private timer: Timer;

  constructor(
    device: BootedDevice,
    adb: AdbClient,
    observeScreenProvider?: () => ObserveScreenLike,
    timer: Timer = defaultTimer
  ) {
    this.device = device;
    this.adb = adb;
    this.timer = timer;
    // The setup holds a resolved AdbClient (not a factory), so wrap it in a
    // trivial factory to satisfy ObserveScreen's factory-only contract (matches
    // the AndroidCtrlProxyClient.getInstance call below).
    this.observeScreenProvider = observeScreenProvider
      ?? (() => new RealObserveScreen(this.device, { create: () => this.adb }));
  }

  /**
   * Set up the required UI state before executing a navigation step.
   * Handles modal stack alignment and selected elements.
   */
  async setupUIState(edge: NavigationEdge, platform: string): Promise<string[]> {
    const requiredState = edge.uiState;

    // Early return if no UI state requirements
    if (!requiredState?.modalStack?.length && !requiredState?.selectedElements?.length) {
      logger.debug(`[UI_STATE_SETUP] No UI state requirements for edge`);
      return [];
    }

    const setupActions: string[] = [];

    // Get current UI state from a fresh observation
    const currentState = await this.getCurrentUIState(platform);
    if (!currentState) {
      logger.warn(`[UI_STATE_SETUP] Could not get current UI state, proceeding anyway`);
      return [];
    }

    // Step 1: Handle modal stack alignment
    if (requiredState.modalStack?.length) {
      const modalStackActions = await this.setupModalStack(
        currentState.modalStack || [],
        requiredState.modalStack,
        platform
      );
      setupActions.push(...modalStackActions);
    }

    // Step 2: Handle selected elements (tabs, menu items, etc.)
    if (requiredState.selectedElements?.length) {
      // Get current state again after modal stack changes if modals were dismissed
      const updatedState = setupActions.length > 0
        ? await this.getCurrentUIState(platform)
        : currentState;

      if (updatedState) {
        const missingElements = this.findMissingSelections(
          requiredState.selectedElements,
          updatedState.selectedElements
        );

        // Tap on missing elements to set up the required state
        for (const element of missingElements) {
          const tapped = await this.tapOnElement(element, platform);
          if (tapped) {
            setupActions.push(`tapOn(${JSON.stringify(element)})`);
          }
        }
      }
    }

    if (setupActions.length === 0) {
      logger.debug(`[UI_STATE_SETUP] UI state already matches requirements`);
    }

    return setupActions;
  }

  /**
   * Set up scroll position to make a navigation element visible.
   * Uses swipeOn with lookFor to scroll until the target element is found.
   */
  async setupScrollPosition(
    scrollPosition: ScrollPosition,
    platform: string
  ): Promise<string | null> {
    logger.info(
      `[UI_STATE_SETUP] Setting up scroll position: ` +
      `target=${scrollPosition.targetElement.text || scrollPosition.targetElement.resourceId}, ` +
      `direction=${scrollPosition.direction}`
    );

    try {
      // Get the swipeOn tool from the registry
      const swipeOnTool = ToolRegistry.getTool("swipeOn");
      if (!swipeOnTool) {
        logger.warn(`[UI_STATE_SETUP] swipeOn tool not found, skipping scroll setup`);
        return null;
      }

      // Build swipeOn arguments with lookFor
      const lookFor = scrollPosition.targetElement.resourceId
        ? { elementId: scrollPosition.targetElement.resourceId }
        : scrollPosition.targetElement.text
          ? { text: scrollPosition.targetElement.text }
          : undefined;
      if (!lookFor) {
        logger.warn("[UI_STATE_SETUP] Scroll position target element missing text/resourceId; skipping scroll setup");
        return null;
      }

      const swipeOnArgs: any = {
        platform,
        direction: scrollPosition.direction,
        lookFor
      };

      // Add container if specified
      if (scrollPosition.container) {
        swipeOnArgs.container = {
          text: scrollPosition.container.text,
          elementId: scrollPosition.container.resourceId
        };
      }

      // Add speed if specified
      if (scrollPosition.speed) {
        swipeOnArgs.speed = scrollPosition.speed;
      }

      // Execute swipeOn with lookFor. Marked internal (#3087) so that under
      // `--actions-diff-observe` this setup scroll neither diffs its observation
      // nor advances the agent-facing diff baseline — the `found` read below still
      // sees the full (unstripped) result.
      const result = await swipeOnTool.handler(markInternalToolCall(swipeOnArgs));

      // `swipeOn` pre-serializes into an MCP envelope via createStructuredToolResponse,
      // which hoists only `success`/`error` to the top level — `found` lives under
      // `structuredContent`. Reading `result?.found` off the envelope was always
      // undefined, so this success branch was dead and setup always logged the
      // "could not find" warning even on a successful scroll (issue #2897; same class
      // as the toolRegistry scroll-position and #2758 lastHierarchy fixes).
      if (getStructuredField<boolean>(result, "success") && getStructuredField<boolean>(result, "found")) {
        logger.info(`[UI_STATE_SETUP] Successfully scrolled to target element`);
        return `swipeOn(lookFor: ${JSON.stringify(scrollPosition.targetElement)})`;
      } else {
        // Element not found after scrolling - log warning but continue
        logger.warn(
          `[UI_STATE_SETUP] Could not find target element after scrolling, ` +
          `continuing anyway (element might still be accessible)`
        );
        return null;
      }
    } catch (error) {
      logger.warn(`[UI_STATE_SETUP] Error setting up scroll position: ${error}, continuing anyway`);
      return null;
    }
  }

  // ==================== Private Helper Methods ====================

  /**
   * Get the current UI state by performing an observation.
   */
  private async getCurrentUIState(_platform: string): Promise<UIState | undefined> {
    try {
      const observeScreen = this.observeScreenProvider();
      const result = await observeScreen.execute();

      if (!result.viewHierarchy) {
        return undefined;
      }

      return new UIStateExtractor().extractFromObservation(result);
    } catch (error) {
      logger.warn(`[UI_STATE_SETUP] Error getting current UI state: ${error}`);
      return undefined;
    }
  }

  /**
   * Find selected elements that are required but not currently selected.
   * Only checks elements that have text (tabs, menu items with labels).
   */
  private findMissingSelections(
    required: Array<{ text?: string; resourceId?: string; contentDesc?: string }>,
    current: Array<{ text?: string; resourceId?: string; contentDesc?: string }>
  ): Array<{ text?: string; resourceId?: string; contentDesc?: string }> {
    const missing: Array<{ text?: string; resourceId?: string; contentDesc?: string }> = [];

    for (const req of required) {
      // Skip elements without text (we need text to tap on them)
      if (!req.text) {
        continue;
      }

      // Check if this element is already selected
      const isSelected = current.some(curr =>
        (req.text && curr.text === req.text) ||
        (req.resourceId && curr.resourceId === req.resourceId)
      );

      if (!isSelected) {
        missing.push(req);
        logger.info(`[UI_STATE_SETUP] Missing selection: ${req.text || req.resourceId}`);
      }
    }

    return missing;
  }

  /**
   * Tap on an element to select it.
   */
  private async tapOnElement(
    element: { text?: string; resourceId?: string; contentDesc?: string },
    platform: string
  ): Promise<boolean> {
    const tapTool = ToolRegistry.getTool("tapOn");
    if (!tapTool) {
      logger.warn(`[UI_STATE_SETUP] tapOn tool not found`);
      return false;
    }

    // Prefer text for tapping as it's most reliable
    const identifier = element.text || element.contentDesc || element.resourceId;
    if (!identifier) {
      logger.warn(`[UI_STATE_SETUP] No identifier for element to tap`);
      return false;
    }

    logger.info(`[UI_STATE_SETUP] Setting up UI state: tapping "${identifier}"`);

    try {
      const args: Record<string, string> = {
        action: "tap",
        platform
      };

      if (element.text) {
        args.text = element.text;
      } else if (element.resourceId) {
        args.elementId = element.resourceId;
      }

      // Internal setup tap (#3087): no diff/strip, no baseline advance.
      await tapTool.handler(markInternalToolCall(args));

      // Small delay for UI to update
      await this.sleep(100);

      return true;
    } catch (error) {
      logger.warn(`[UI_STATE_SETUP] Failed to tap on "${identifier}": ${error}`);
      return false;
    }
  }

  /**
   * Align the current modal stack with the required modal stack.
   * Dismisses extra modals and opens missing ones.
   */
  private async setupModalStack(
    currentStack: ModalState[],
    requiredStack: ModalState[],
    platform: string
  ): Promise<string[]> {
    const actions: string[] = [];

    // Dismiss extra modals from the top down
    while (currentStack.length > requiredStack.length) {
      const topModal = currentStack[currentStack.length - 1];
      logger.info(`[UI_STATE_SETUP] Dismissing modal: ${topModal.type} (layer ${topModal.layer})`);

      const dismissed = await this.dismissTopModal(topModal, platform);
      if (dismissed) {
        actions.push(`dismissModal(${topModal.type})`);
        currentStack.pop();
        // Small delay for modal to dismiss
        await this.sleep(300);
      } else {
        logger.warn(`[UI_STATE_SETUP] Failed to dismiss ${topModal.type}, stopping modal alignment`);
        break;
      }
    }

    // Note: Opening modals is complex and depends on app-specific UI interactions
    // For now, we only handle dismissal. Opening modals will happen naturally
    // when executing the navigation edge interaction.
    if (requiredStack.length > currentStack.length) {
      logger.debug(
        `[UI_STATE_SETUP] Required modal stack has ${requiredStack.length - currentStack.length} more modal(s), ` +
        `will be opened by navigation interaction`
      );
    }

    return actions;
  }

  /**
   * Dismiss the top modal using context-aware dismissal methods.
   * Tries different strategies based on modal type.
   */
  private async dismissTopModal(modal: ModalState, platform: string): Promise<boolean> {
    logger.debug(`[UI_STATE_SETUP] Attempting to dismiss ${modal.type} modal`);

    // Strategy 1: Try back button (works for most dialogs)
    if (modal.type === "dialog") {
      try {
        await this.pressBack();
        await this.sleep(200);

        // Verify dismissal
        const currentState = await this.getCurrentUIState(platform);
        const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
        if (dismissed) {
          logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with back button`);
          return true;
        }
      } catch (error) {
        logger.debug(`[UI_STATE_SETUP] Back button failed for ${modal.type}: ${error}`);
      }
    }

    // Strategy 2: Swipe down for bottom sheets
    if (modal.type === "bottomsheet") {
      try {
        // The registered interaction tool is `swipeOn`, not `swipe` (see
        // src/server/interactionTools.ts). Resolving `getTool("swipe")` always
        // returned undefined, so this whole branch was dead code and bottom
        // sheets that only dismiss via swipe-down silently fell through to the
        // back-button fallback below (issue #3106).
        const swipeTool = ToolRegistry.getTool("swipeOn");
        if (swipeTool) {
          // Swipe down to dismiss the bottom sheet. `swipeOn` takes `direction`
          // (no `action` field). Internal setup swipe (#3087): no diff/strip, no
          // baseline advance.
          await swipeTool.handler(markInternalToolCall({
            direction: "down",
            platform
          }));
          await this.sleep(200);

          // Verify dismissal
          const currentState = await this.getCurrentUIState(platform);
          const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
          if (dismissed) {
            logger.info(`[UI_STATE_SETUP] Dismissed bottom sheet with swipe down`);
            return true;
          }
        }

        // Fallback to back button
        await this.pressBack();
        await this.sleep(200);

        const currentState = await this.getCurrentUIState(platform);
        const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
        if (dismissed) {
          logger.info(`[UI_STATE_SETUP] Dismissed bottom sheet with back button`);
          return true;
        }
      } catch (error) {
        logger.debug(`[UI_STATE_SETUP] Swipe down failed for bottom sheet: ${error}`);
      }
    }

    // Strategy 3: Look for close/cancel button
    if (modal.type === "dialog" || modal.type === "bottomsheet") {
      try {
        const closeButtonTapped = await this.tapCloseButton(platform);
        if (closeButtonTapped) {
          await this.sleep(200);

          // Verify dismissal
          const currentState = await this.getCurrentUIState(platform);
          const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
          if (dismissed) {
            logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with close button`);
            return true;
          }
        }
      } catch (error) {
        logger.debug(`[UI_STATE_SETUP] Close button tap failed: ${error}`);
      }
    }

    // Strategy 4: Tap outside (for popups and menus)
    if (modal.type === "popup" || modal.type === "menu" || modal.type === "overlay") {
      try {
        // Tap top-left corner (usually outside modal)
        await this.adb.executeCommand("shell input tap 50 50");
        await this.sleep(200);

        // Verify dismissal
        const currentState = await this.getCurrentUIState(platform);
        const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
        if (dismissed) {
          logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} by tapping outside`);
          return true;
        }
      } catch (error) {
        logger.debug(`[UI_STATE_SETUP] Tap outside failed: ${error}`);
      }
    }

    // Final fallback: back button
    try {
      await this.pressBack();
      await this.sleep(200);

      const currentState = await this.getCurrentUIState(platform);
      const dismissed = !currentState?.modalStack?.some(m => m.windowId === modal.windowId);
      if (dismissed) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with back button (fallback)`);
        return true;
      }
    } catch (error) {
      logger.debug(`[UI_STATE_SETUP] Final back button attempt failed: ${error}`);
    }

    logger.warn(`[UI_STATE_SETUP] All dismissal strategies failed for ${modal.type}`);
    return false;
  }

  /**
   * Try to tap a close/cancel button in the current view.
   */
  private async tapCloseButton(platform: string): Promise<boolean> {
    const tapTool = ToolRegistry.getTool("tapOn");
    if (!tapTool) {
      return false;
    }

    // Common close button texts
    const closeTexts = ["Close", "Cancel", "Dismiss", "×", "✕"];

    for (const text of closeTexts) {
      try {
        // Internal close-button tap (#3087): no diff/strip, no baseline advance.
        await tapTool.handler(markInternalToolCall({
          action: "tap",
          text,
          platform
        }));
        logger.debug(`[UI_STATE_SETUP] Tapped close button: "${text}"`);
        return true;
      } catch (error) {
        // Button not found, try next
        continue;
      }
    }

    return false;
  }

  /**
   * Press the back button.
   */
  private async pressBack(): Promise<void> {
    try {
      const client = AndroidCtrlProxyClient.getInstance(this.device, { create: () => this.adb });
      const result = await client.requestGlobalAction("back", 3000);
      if (result.success) {
        logger.debug("[UI_STATE_SETUP] Pressed back via accessibility service");
        return;
      }
    } catch {
      // Fall through to ADB
    }
    await this.adb.executeCommand("shell input keyevent 4");
    logger.debug("[UI_STATE_SETUP] Pressed back via ADB keyevent");
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return this.timer.sleep(ms);
  }
}
