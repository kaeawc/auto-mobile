import { BootedDevice } from "../../models";
import { ObserveResult } from "../../models/ObserveResult";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { logger } from "../../utils/logger";
import { ToolRegistry } from "../../server/toolRegistry";
import { throwIfInternalToolFailed } from "../../server/internalToolCall";
import { NavigationEdge, UIState } from "./NavigationGraphManager";
import { ModalState, ScrollPosition } from "../../utils/interfaces/NavigationGraph";
import { UIStateExtractor } from "./UIStateExtractor";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { PressButton } from "../action/PressButton";
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
  private sessionUuid?: string;

  constructor(
    device: BootedDevice,
    adb: AdbClient,
    observeScreenProvider?: () => ObserveScreenLike,
    timer: Timer = defaultTimer,
    sessionUuid?: string,
  ) {
    this.device = device;
    this.adb = adb;
    this.timer = timer;
    this.sessionUuid = sessionUuid;
    // The setup holds a resolved AdbClient (not a factory), so wrap it in a
    // trivial factory to satisfy ObserveScreen's factory-only contract (matches
    // the AndroidCtrlProxyClient.getInstance call below).
    this.observeScreenProvider =
      observeScreenProvider ??
      (() => new RealObserveScreen(this.device, { create: () => this.adb }));
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
        platform,
      );
      setupActions.push(...modalStackActions);
    }

    // Step 2: Handle selected elements (tabs, menu items, etc.)
    if (requiredState.selectedElements?.length) {
      // Get current state again after modal stack changes if modals were dismissed
      const updatedState =
        setupActions.length > 0 ? await this.getCurrentUIState(platform) : currentState;

      if (updatedState) {
        setupActions.push(
          ...(await this.setupMissingSelections(
            requiredState.selectedElements,
            updatedState.selectedElements,
            platform,
          )),
        );
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
    platform: string,
  ): Promise<string | null> {
    logger.info(
      `[UI_STATE_SETUP] Setting up scroll position: ` +
        `target=${scrollPosition.targetElement.text || scrollPosition.targetElement.resourceId}, ` +
        `direction=${scrollPosition.direction}`,
    );

    try {
      // Resolve swipeOn first so a missing tool degrades gracefully (return null)
      // rather than throwing out of the `callInternalTyped` seam below.
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
        logger.warn(
          "[UI_STATE_SETUP] Scroll position target element missing text/resourceId; skipping scroll setup",
        );
        return null;
      }

      const swipeOnArgs: any = {
        platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        direction: scrollPosition.direction,
        lookFor,
      };

      // Add container if specified
      if (scrollPosition.container) {
        swipeOnArgs.container = {
          text: scrollPosition.container.text,
          elementId: scrollPosition.container.resourceId,
        };
      }

      // Add speed if specified
      if (scrollPosition.speed) {
        swipeOnArgs.speed = scrollPosition.speed;
      }

      // Execute swipeOn with lookFor via the internal-call seam (#3108), which
      // marks the call internal (#3087) so that under `--actions-diff-observe`
      // this setup scroll neither diffs its observation nor advances the
      // agent-facing diff baseline — the `found` read below still sees the full
      // (unstripped) result.
      // Typed envelope (issues #2932 / #3222): `callInternalTyped` threads the
      // concrete `SwipeOnToolPayload` type through the registry seam and validates
      // the shape at runtime, so `result` is `StructuredToolResponse<…> | undefined`
      // with no unchecked cast. `found` lives under `structuredContent`
      // (createStructuredToolResponse hoists only `success`/`error`); a raw
      // `result?.found` off the envelope was always undefined, leaving this success
      // branch dead so setup logged the "could not find" warning even on a
      // successful scroll (issue #2897; same class as the toolRegistry
      // scroll-position and #2758 lastHierarchy fixes). With `result` typed,
      // `result.found` is a compile error and the `getStructuredField` keys are
      // checked against the payload.
      const result = await ToolRegistry.callInternalTyped("swipeOn", swipeOnArgs);

      if (getStructuredField(result, "success") && getStructuredField(result, "found")) {
        logger.info(`[UI_STATE_SETUP] Successfully scrolled to target element`);
        return `swipeOn(lookFor: ${JSON.stringify(scrollPosition.targetElement)})`;
      } else {
        // Element not found after scrolling - log warning but continue
        logger.warn(
          `[UI_STATE_SETUP] Could not find target element after scrolling, ` +
            `continuing anyway (element might still be accessible)`,
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
    current: Array<{ text?: string; resourceId?: string; contentDesc?: string }>,
  ): Array<{ text?: string; resourceId?: string; contentDesc?: string }> {
    const missing: Array<{ text?: string; resourceId?: string; contentDesc?: string }> = [];

    for (const req of required) {
      if (!req.text && !req.resourceId && !req.contentDesc) {
        continue;
      }

      // Check if this element is already selected
      const isSelected = current.some(
        (curr) =>
          (req.text && curr.text === req.text) ||
          (req.resourceId && curr.resourceId === req.resourceId) ||
          (req.contentDesc && curr.contentDesc === req.contentDesc),
      );

      if (!isSelected) {
        missing.push(req);
        logger.info(
          `[UI_STATE_SETUP] Missing selection: ${req.text || req.resourceId || req.contentDesc}`,
        );
      }
    }

    return missing;
  }

  private async setupMissingSelections(
    required: Array<{ text?: string; resourceId?: string; contentDesc?: string }>,
    current: Array<{ text?: string; resourceId?: string; contentDesc?: string }>,
    platform: string,
  ): Promise<string[]> {
    const actions: string[] = [];
    for (const element of this.findMissingSelections(required, current)) {
      if (await this.tapOnElement(element, platform)) {
        actions.push(`tapOn(${JSON.stringify(element)})`);
      }
    }
    return actions;
  }

  /**
   * Tap on an element to select it.
   */
  private async tapOnElement(
    element: { text?: string; resourceId?: string; contentDesc?: string },
    platform: string,
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
      const args: Record<string, unknown> = {
        action: "tap",
        platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
      };

      if (element.text) {
        args.selector = { text: element.text };
      } else if (element.resourceId) {
        args.selector = { elementId: element.resourceId };
      } else if (element.contentDesc) {
        // tapOn exposes accessible labels through its text selector; contentDesc
        // is not a public selector field on the internal tool contract.
        args.selector = { text: element.contentDesc };
      }

      // Internal setup tap (#3087) via the callInternal seam (#3108): no
      // diff/strip, no baseline advance.
      const response = await ToolRegistry.callInternal(tapTool, args);
      throwIfInternalToolFailed(response, "tapOn", platform);

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
    platform: string,
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
        logger.warn(
          `[UI_STATE_SETUP] Failed to dismiss ${topModal.type}, stopping modal alignment`,
        );
        break;
      }
    }

    // Note: Opening modals is complex and depends on app-specific UI interactions
    // For now, we only handle dismissal. Opening modals will happen naturally
    // when executing the navigation edge interaction.
    if (requiredStack.length > currentStack.length) {
      logger.debug(
        `[UI_STATE_SETUP] Required modal stack has ${requiredStack.length - currentStack.length} more modal(s), ` +
          `will be opened by navigation interaction`,
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
        await this.pressBack(platform);
        await this.sleep(200);

        // Verify dismissal
        const currentState = await this.getCurrentUIState(platform);
        const dismissed = !currentState?.modalStack?.some((m) => m.windowId === modal.windowId);
        if (dismissed) {
          logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with back button`);
          return true;
        }
      } catch (error) {
        logger.debug(`[UI_STATE_SETUP] Back button failed for ${modal.type}: ${error}`);
      }
    }

    // Strategy 2: Swipe down for bottom sheets
    if (modal.type === "bottomsheet" && (await this.dismissBottomSheet(modal, platform))) {
      return true;
    }

    // Strategy 3: Look for close/cancel button
    if (
      (modal.type === "dialog" || modal.type === "bottomsheet") &&
      (await this.dismissWithCloseButton(modal, platform))
    ) {
      return true;
    }

    // Strategy 4: Tap outside (for popups and menus)
    if (
      (modal.type === "popup" || modal.type === "menu" || modal.type === "overlay") &&
      (await this.dismissByTappingOutside(modal, platform))
    ) {
      return true;
    }

    // Final fallback: back button
    try {
      await this.pressBack(platform);
      await this.sleep(200);

      const currentState = await this.getCurrentUIState(platform);
      const dismissed = !currentState?.modalStack?.some((m) => m.windowId === modal.windowId);
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

  private async dismissBottomSheet(modal: ModalState, platform: string): Promise<boolean> {
    try {
      // The registered interaction tool is `swipeOn`, not `swipe` (see
      // src/server/interactionTools.ts). Resolving `getTool("swipe")` always
      // returned undefined, so this whole branch was dead code and bottom
      // sheets that only dismiss via swipe-down silently fell through to the
      // back-button fallback below (issue #3106).
      const swipeTool = ToolRegistry.getTool("swipeOn");
      if (swipeTool) {
        // Swipe down from mid-screen to drag the sheet down and dismiss it.
        // `swipeOn` takes `direction` (no `action` field). `autoTarget: false`
        // is essential here: with the default (true) and no lookFor/container,
        // swipeOn targets a scrollable child and would scroll the sheet's inner
        // list instead of dragging the sheet itself down (SwipeOn.execute). We
        // want the full-screen downward swipe (executeScreenSwipe) that a
        // dismissal needs. Internal setup swipe (#3087) via the callInternal
        // seam (#3108): no diff/strip, no baseline advance.
        await ToolRegistry.callInternal(swipeTool, {
          direction: "down",
          autoTarget: false,
          platform,
          deviceId: this.device.deviceId,
          ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        });
        await this.sleep(200);
        if (await this.isModalDismissed(modal, platform)) {
          logger.info("[UI_STATE_SETUP] Dismissed bottom sheet with swipe down");
          return true;
        }
      }

      await this.pressBack(platform);
      await this.sleep(200);
      if (await this.isModalDismissed(modal, platform)) {
        logger.info("[UI_STATE_SETUP] Dismissed bottom sheet with back button");
        return true;
      }
    } catch (error) {
      logger.debug(`[UI_STATE_SETUP] Swipe down failed for bottom sheet: ${error}`);
    }
    return false;
  }

  private async dismissWithCloseButton(modal: ModalState, platform: string): Promise<boolean> {
    try {
      if (await this.tapCloseButton(platform)) {
        await this.sleep(200);
        if (await this.isModalDismissed(modal, platform)) {
          logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with close button`);
          return true;
        }
      }
    } catch (error) {
      logger.debug(`[UI_STATE_SETUP] Close button tap failed: ${error}`);
    }
    return false;
  }

  private async dismissByTappingOutside(modal: ModalState, platform: string): Promise<boolean> {
    if (platform !== "android") {
      return false;
    }
    try {
      // Android supports coordinate taps, which preserve the established
      // scrim-dismissal behavior. iOS has no equivalent public interaction
      // tool, so it proceeds to the single platform-aware back fallback.
      await this.adb.executeCommand("shell input tap 50 50");
      await this.sleep(200);
      if (await this.isModalDismissed(modal, platform)) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} by tapping outside`);
        return true;
      }
    } catch (error) {
      logger.debug(`[UI_STATE_SETUP] Tap outside failed: ${error}`);
    }
    return false;
  }

  private async isModalDismissed(modal: ModalState, platform: string): Promise<boolean> {
    const currentState = await this.getCurrentUIState(platform);
    return !currentState?.modalStack?.some((m) => m.windowId === modal.windowId);
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
        // Internal close-button tap (#3087) via the callInternal seam (#3108):
        // no diff/strip, no baseline advance.
        await ToolRegistry.callInternal(tapTool, {
          selector: { text },
          action: "tap",
          platform,
          deviceId: this.device.deviceId,
          ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        });
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
  private async pressBack(platform: string): Promise<void> {
    if (platform === "android") {
      // Modal recovery belongs to this instance's injected ADB/timer boundary.
      // Calling press() avoids a nested observed interaction while preserving
      // the accessibility-service then ADB fallback behavior.
      const result = await new PressButton(this.device, this.adb, this.timer).press("back");
      if (!result.success) {
        throw new Error(result.error ?? "Android back navigation failed");
      }
      logger.debug("[UI_STATE_SETUP] Pressed back via Android action dependencies");
      return;
    }

    const response = await ToolRegistry.callInternal("pressButton", {
      button: "back",
      platform,
      deviceId: this.device.deviceId,
      ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
    });
    throwIfInternalToolFailed(response, "pressButton", platform);
    logger.debug(`[UI_STATE_SETUP] Pressed back via ${platform} interaction tool`);
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return this.timer.sleep(ms);
  }
}
