import { BootedDevice } from "../../models";
import { ObserveResult } from "../../models/ObserveResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { ToolRegistry } from "../../server/toolRegistry";
import { throwIfInternalToolFailed } from "../../server/internalToolCall";
import { NavigationEdge, UIState } from "./NavigationGraphManager";
import { ModalState, ScrollPosition } from "../../utils/interfaces/NavigationGraph";
import { UIStateExtractor } from "./UIStateExtractor";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { PressButton } from "../action/PressButton";
import { throwIfAborted, awaitWhileRequestIsLive, getStructuredField } from "../../utils/toolUtils";
import { UIStateSetup } from "./interfaces/UIStateSetup";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { ActionableError } from "../../models/ActionableError";
import { isTruthy } from "../../models/Element";
import { ElementResolver, matchedSourceNode } from "../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

/**
 * Default implementation of UIStateSetup that handles UI state alignment
 * before navigation steps.
 */
/**
 * Minimal observe seam so UI-state setup can be unit-tested without driving a
 * real ObserveScreen (WebSocket / device I/O).
 */
export interface ObserveScreenLike {
  execute(options?: { signal?: AbortSignal }): Promise<ObserveResult>;
}

/** A setup gesture left the source screen; replay must stop, including fallback edges. */
export class UIStateSetupScreenChangedError extends ActionableError {}

export class DefaultUIStateSetup implements UIStateSetup {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private observeScreenProvider: () => ObserveScreenLike;
  private timer: Timer;
  private sessionUuid?: string;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    observeScreenProvider?: () => ObserveScreenLike,
    timer: Timer = defaultTimer,
    sessionUuid?: string,
  ) {
    this.device = device;
    this.adb = adb;
    this.timer = timer;
    this.sessionUuid = sessionUuid;
    // The setup holds a resolved ADB executor (not a factory), so wrap it in a
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
  async setupUIState(
    edge: NavigationEdge,
    platform: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    throwIfAborted(signal);
    const requiredState = edge.uiState;

    // Early return if no UI state requirements
    if (!requiredState || this.isEmptyUIState(requiredState)) {
      logger.debug(`[UI_STATE_SETUP] No UI state requirements for edge`);
      return [];
    }

    const setupActions: string[] = [];

    // Get current UI state from a fresh observation
    const currentState = await this.getCurrentUIState(platform, signal);
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
        signal,
      );
      setupActions.push(...modalStackActions);
    }

    // Step 2: Handle selected elements (tabs, menu items, etc.)
    if (requiredState.selectedElements?.length) {
      await this.setupSelectedElements(requiredState, currentState, setupActions, platform, signal);
    }

    if (setupActions.length === 0) {
      logger.debug(`[UI_STATE_SETUP] UI state already matches requirements`);
    }

    return setupActions;
  }

  private isEmptyUIState(requiredState: UIState): boolean {
    return !requiredState.modalStack?.length && !requiredState.selectedElements?.length;
  }

  private async setupSelectedElements(
    requiredState: UIState,
    currentState: UIState,
    setupActions: string[],
    platform: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Get current state again after modal stack changes if modals were dismissed
    const updatedState =
      setupActions.length > 0 ? await this.getCurrentUIState(platform, signal) : currentState;

    if (updatedState) {
      setupActions.push(
        ...(await this.setupMissingSelections(
          requiredState.selectedElements,
          updatedState.selectedElements,
          platform,
          signal,
        )),
      );
    }
  }

  /**
   * Set up scroll position to make a navigation element visible.
   * Uses swipeOn with lookFor to scroll until the target element is found.
   */
  async setupScrollPosition(
    scrollPosition: ScrollPosition,
    platform: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    logger.info(
      `[UI_STATE_SETUP] Setting up scroll position: ` +
        `target=${scrollPosition.targetElement.text || scrollPosition.targetElement.resourceId}, ` +
        `direction=${scrollPosition.direction}`,
    );

    try {
      throwIfAborted(signal);
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
      throwIfAborted(signal);
      const result = await ToolRegistry.callInternalTyped(
        "swipeOn",
        swipeOnArgs,
        undefined,
        signal,
      );
      throwIfAborted(signal);

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
      throwIfAborted(signal);
      logger.warn(`[UI_STATE_SETUP] Error setting up scroll position: ${error}, continuing anyway`);
      return null;
    }
  }

  // ==================== Private Helper Methods ====================

  /**
   * Get the current UI state by performing an observation.
   */
  private async getCurrentUIState(
    _platform: string,
    signal?: AbortSignal,
  ): Promise<UIState | undefined> {
    try {
      throwIfAborted(signal);
      const observeScreen = this.observeScreenProvider();
      const result = await awaitWhileRequestIsLive(
        observeScreen.execute(signal ? { signal } : undefined),
        signal,
      );
      throwIfAborted(signal);

      if (!result.viewHierarchy) {
        return undefined;
      }

      return new UIStateExtractor().extractFromObservation(result);
    } catch (error) {
      throwIfAborted(signal);
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
    signal?: AbortSignal,
  ): Promise<string[]> {
    const actions: string[] = [];
    for (const element of this.findMissingSelections(required, current)) {
      if (await this.tapOnElement(element, platform, signal)) {
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
    signal?: AbortSignal,
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

    let before: ObserveResult;
    try {
      throwIfAborted(signal);
      before = await awaitWhileRequestIsLive(
        this.observeScreenProvider().execute(signal ? { signal } : undefined),
        signal,
      );
      const selector = this.selectionTapSelector(element, before);
      if (!selector) {
        logger.warn(`[UI_STATE_SETUP] No exact selectable control for "${identifier}"; skipping`);
        return false;
      }
      logger.info(`[UI_STATE_SETUP] Setting up UI state: tapping "${identifier}"`);
      const args: Record<string, unknown> = {
        selector,
        action: "tap",
        platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
      };

      // Internal setup tap (#3087) via the callInternal seam (#3108): no
      // diff/strip, no baseline advance.
      throwIfAborted(signal);
      const response = await ToolRegistry.callInternal(tapTool, args, undefined, signal);
      throwIfAborted(signal);
      throwIfInternalToolFailed(response, "tapOn", platform);

      // Small delay for UI to update
      await this.sleep(100, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[UI_STATE_SETUP] Failed to tap on "${identifier}": ${error}`);
      return false;
    }

    // A successful setup tap must stay on its source screen. Keep this failure outside
    // the best-effort tap catch so navigateTo stops before dispatching the recorded step.
    await this.verifySelectionScreen(before, identifier, signal);
    return true;
  }

  private async verifySelectionScreen(
    before: ObserveResult,
    identifier: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const after = await awaitWhileRequestIsLive(
      this.observeScreenProvider().execute(signal ? { signal } : undefined),
      signal,
    );
    throwIfAborted(signal);
    let from = before.screenIdentity?.key;
    let to = after.screenIdentity?.key;
    if (!from || !to) {
      const extractor = new UIStateExtractor();
      from = extractor.extractFromObservation(before)?.destinationId;
      to = extractor.extractFromObservation(after)?.destinationId;
    }
    if (from && to && from !== to) {
      throw new UIStateSetupScreenChangedError(
        `UI-state setup tap on "${identifier}" changed screen from "${from}" to "${to}"; navigation replay aborted`,
      );
    }
  }

  private selectionTapSelector(
    element: { text?: string; resourceId?: string; contentDesc?: string },
    observation: ObserveResult,
  ): { text: string } | { elementId: string } | undefined {
    if (!observation.viewHierarchy) {
      return undefined;
    }
    const selector: { text: string } | { elementId: string } = element.text
      ? { text: element.text }
      : element.resourceId
        ? { elementId: element.resourceId }
        : { text: element.contentDesc! };
    const nodes = new SearchableHierarchy().project(observation.viewHierarchy);
    // Resolve the same default tap candidate as tapOn, including clickable promotion.
    // An exact label elsewhere must not authorize a substring-matched button.
    const result = new ElementResolver().resolve(
      { id: observation.observationId, nodes },
      selector,
      { action: "tap" },
    );
    const matched = matchedSourceNode(result, "text" in selector ? selector : undefined);
    if (!matched || !result.chosen) {
      return undefined;
    }
    const exact =
      "text" in selector
        ? matched.textFields.includes(selector.text)
        : matched.nativeId === selector.elementId || matched.nodeKey === selector.elementId;
    return exact && this.isSelectableControl(result.chosen, nodes) ? selector : undefined;
  }

  private isSelectableControl(node: SearchableEntry, nodes: readonly SearchableEntry[]): boolean {
    const attrs = node.properties;
    if (
      attrs.selected !== undefined ||
      isTruthy(attrs.checkable) ||
      /^(tab|switch|checkbox|radio|toggle)$/i.test(String(attrs.role ?? "")) ||
      /TabButton|TabWidget|Switch|CheckBox|RadioButton|ToggleButton/i.test(node.className ?? "")
    ) {
      return true;
    }
    // UIKit captures expose unselected tab buttons as UIButton children of UITabBar.
    let parent = node.parentIndex;
    while (parent !== undefined) {
      const ancestor = nodes[parent];
      if (/TabBar/i.test(ancestor.className ?? "")) {
        return true;
      }
      parent = ancestor.parentIndex;
    }
    return false;
  }

  /**
   * Align the current modal stack with the required modal stack.
   * Dismisses extra modals and opens missing ones.
   */
  private async setupModalStack(
    currentStack: ModalState[],
    requiredStack: ModalState[],
    platform: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const actions: string[] = [];

    // Dismiss extra modals from the top down
    while (currentStack.length > requiredStack.length) {
      const topModal = currentStack[currentStack.length - 1];
      logger.info(`[UI_STATE_SETUP] Dismissing modal: ${topModal.type} (layer ${topModal.layer})`);

      const dismissed = await this.dismissTopModal(topModal, platform, signal);
      if (dismissed) {
        actions.push(`dismissModal(${topModal.type})`);
        currentStack.pop();
        // Small delay for modal to dismiss
        await this.sleep(300, signal);
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
  private async dismissTopModal(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    logger.debug(`[UI_STATE_SETUP] Attempting to dismiss ${modal.type} modal`);

    // Strategy 1: Try back button (works for most dialogs)
    if (modal.type === "dialog" && (await this.dismissDialogWithBack(modal, platform, signal))) {
      return true;
    }

    // Strategy 2: Swipe down for bottom sheets
    if (modal.type === "bottomsheet" && (await this.dismissBottomSheet(modal, platform, signal))) {
      return true;
    }

    if (await this.dismissWithTap(modal, platform, signal)) {
      return true;
    }

    // Final fallback: back button
    try {
      throwIfAborted(signal);
      await this.pressBack(platform, signal);
      await this.sleep(200, signal);

      if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with back button (fallback)`);
        return true;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[UI_STATE_SETUP] Final back button attempt failed: ${error}`);
    }

    logger.warn(`[UI_STATE_SETUP] All dismissal strategies failed for ${modal.type}`);
    return false;
  }

  private async dismissWithTap(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Strategy 3: Look for close/cancel button
    if (
      (modal.type === "dialog" || modal.type === "bottomsheet") &&
      (await this.dismissWithCloseButton(modal, platform, signal))
    ) {
      return true;
    }

    // Strategy 4: Tap outside (for popups and menus)
    if (
      (modal.type === "popup" || modal.type === "menu" || modal.type === "overlay") &&
      (await this.dismissByTappingOutside(modal, platform, signal))
    ) {
      return true;
    }

    return false;
  }

  private async dismissDialogWithBack(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      throwIfAborted(signal);
      await this.pressBack(platform, signal);
      await this.sleep(200, signal);

      // Verify dismissal
      if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with back button`);
        return true;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[UI_STATE_SETUP] Back button failed for ${modal.type}: ${error}`);
    }
    return false;
  }

  private async dismissBottomSheet(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      throwIfAborted(signal);
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
        await ToolRegistry.callInternal(
          swipeTool,
          {
            direction: "down",
            autoTarget: false,
            platform,
            deviceId: this.device.deviceId,
            ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
          },
          undefined,
          signal,
        );
        throwIfAborted(signal);
        await this.sleep(200, signal);
        if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
          logger.info("[UI_STATE_SETUP] Dismissed bottom sheet with swipe down");
          return true;
        }
      }

      await this.pressBack(platform, signal);
      await this.sleep(200, signal);
      if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
        logger.info("[UI_STATE_SETUP] Dismissed bottom sheet with back button");
        return true;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[UI_STATE_SETUP] Swipe down failed for bottom sheet: ${error}`);
    }
    return false;
  }

  private async dismissWithCloseButton(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      throwIfAborted(signal);
      if (await this.tapCloseButton(modal, platform, signal)) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} with close button`);
        return true;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[UI_STATE_SETUP] Close button tap failed: ${error}`);
    }
    return false;
  }

  private async dismissByTappingOutside(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (platform !== "android") {
      return false;
    }
    try {
      throwIfAborted(signal);
      // Android supports coordinate taps, which preserve the established
      // scrim-dismissal behavior. iOS has no equivalent public interaction
      // tool, so it proceeds to the single platform-aware back fallback.
      await this.adb.executeCommand(
        "shell input tap 50 50",
        undefined,
        undefined,
        undefined,
        signal,
      );
      throwIfAborted(signal);
      await this.sleep(200, signal);
      if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
        logger.info(`[UI_STATE_SETUP] Dismissed ${modal.type} by tapping outside`);
        return true;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[UI_STATE_SETUP] Tap outside failed: ${error}`);
    }
    return false;
  }

  /**
   * Confirm dismissal for every strategy by observing that the modal's window
   * is no longer present. An unavailable observation (no view hierarchy or an
   * observation error) leaves the outcome unconfirmed (#6319, #6748), so the
   * caller tries the next candidate or strategy instead of claiming success.
   */
  private async isModalConfirmedDismissed(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const currentState = await this.getCurrentUIState(platform, signal);
    if (!currentState) {
      return false;
    }
    return !currentState.modalStack?.some((m) => m.windowId === modal.windowId);
  }

  /**
   * Try to tap a close/cancel button in the current view.
   *
   * Each candidate text is tried in turn, and a candidate only counts as
   * success when it BOTH (a) resolved to a real element that the internal
   * `tapOn` call actually tapped, and (b) genuinely dismissed `modal` (verified
   * by re-observing and checking the modal is no longer present). Neither
   * check alone is sufficient: `callInternal` resolves (does not throw) even
   * when `tapOn` reports `{success: false}` for a missing element (#6123), and
   * a tap that hits a real but wrong element (e.g. a non-dismissing "Close"
   * label elsewhere on screen) would otherwise be mistaken for success. A
   * failed or ineffective candidate falls through to the next text instead of
   * short-circuiting the loop.
   */
  private async tapCloseButton(
    modal: ModalState,
    platform: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const tapTool = ToolRegistry.getTool("tapOn");
    if (!tapTool) {
      return false;
    }

    // Common close button texts
    const closeTexts = ["Close", "Cancel", "Dismiss", "×", "✕"];

    for (const text of closeTexts) {
      try {
        throwIfAborted(signal);
        // Internal close-button tap (#3087) via the callInternal seam (#3108):
        // no diff/strip, no baseline advance.
        const response = await ToolRegistry.callInternal(
          tapTool,
          {
            selector: { text },
            action: "tap",
            platform,
            deviceId: this.device.deviceId,
            ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
          },
          undefined,
          signal,
        );
        throwIfAborted(signal);
        throwIfInternalToolFailed(response, "tapOn", platform);

        await this.sleep(200, signal);
        if (await this.isModalConfirmedDismissed(modal, platform, signal)) {
          logger.debug(`[UI_STATE_SETUP] Tapped close button: "${text}"`);
          return true;
        }
        logger.debug(
          `[UI_STATE_SETUP] Tapped "${text}" but ${modal.type} is still present, trying next candidate`,
        );
      } catch (error) {
        throwIfAborted(signal);
        // Button not found, or the tap failed outright — try the next candidate.
        logger.debug(`[UI_STATE_SETUP] Close button candidate "${text}" failed: ${error}`);
        continue;
      }
    }

    return false;
  }

  /**
   * Press the back button.
   */
  private async pressBack(platform: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (platform === "android") {
      // Modal recovery belongs to this instance's injected ADB/timer boundary.
      // Calling press() avoids a nested observed interaction while preserving
      // the accessibility-service then ADB fallback behavior.
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
      logger.debug("[UI_STATE_SETUP] Pressed back via Android action dependencies");
      return;
    }

    const response = await ToolRegistry.callInternal(
      "pressButton",
      {
        button: "back",
        platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
      },
      undefined,
      signal,
    );
    throwIfAborted(signal);
    throwIfInternalToolFailed(response, "pressButton", platform);
    logger.debug(`[UI_STATE_SETUP] Pressed back via ${platform} interaction tool`);
  }

  /**
   * Sleep for the specified duration.
   */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(this.timer.sleep(ms), signal);
    throwIfAborted(signal);
  }
}
