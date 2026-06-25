/**
 * SetAccessibilityFocus - sets or clears the Android TalkBack accessibility-focus cursor.
 *
 * Resolves a text / contentDesc / resourceId selector to a resource-id, then asks the
 * CtrlProxy AccessibilityService to perform ACTION_ACCESSIBILITY_FOCUS ("focus") or
 * ACTION_CLEAR_ACCESSIBILITY_FOCUS ("clear_focus") on the matched node.
 *
 * Android only: iOS has no VoiceOver-focus backend wired, so the tool errors clearly
 * rather than silently no-op'ing.
 */

import {
  ActionableError,
  BootedDevice,
  CurrentFocusResult,
  Element,
  SetAccessibilityFocusOptions,
  SetAccessibilityFocusResult,
  ViewHierarchyResult
} from "../../models";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";

/**
 * Minimal accessibility-focus capability surface, so this feature can be unit-tested
 * with a fake instead of a real device/WebSocket.
 */
export interface AccessibilityFocusService {
  setAccessibilityFocus(resourceId: string): Promise<void>;
  clearAccessibilityFocus(resourceId: string): Promise<void>;
  requestCurrentFocus(): Promise<CurrentFocusResult>;
}

export interface SetAccessibilityFocusDependencies {
  finder?: ElementFinder;
  observeScreen?: ObserveScreen;
  /** Factory so production resolves the live CtrlProxy client lazily; fakes inject directly. */
  serviceFactory?: (device: BootedDevice) => AccessibilityFocusService;
}

export class SetAccessibilityFocus {
  private readonly device: BootedDevice;
  private readonly finder: ElementFinder;
  private readonly observeScreen: ObserveScreen;
  private readonly serviceFactory: (device: BootedDevice) => AccessibilityFocusService;

  constructor(device: BootedDevice, deps: SetAccessibilityFocusDependencies = {}) {
    this.device = device;
    this.finder = deps.finder ?? new DefaultElementFinder();
    this.observeScreen = deps.observeScreen ?? new RealObserveScreen(device, defaultAdbClientFactory);
    this.serviceFactory =
      deps.serviceFactory ?? ((d: BootedDevice) => AndroidCtrlProxyClient.getInstance(d, defaultAdbClientFactory));
  }

  async execute(options: SetAccessibilityFocusOptions): Promise<SetAccessibilityFocusResult> {
    if (this.device.platform !== "android") {
      throw new ActionableError(
        "accessibilityFocus is only supported on Android (TalkBack). iOS VoiceOver focus is not yet implemented."
      );
    }

    const action = options.action ?? "set";

    if (!options.resourceId && !options.text && !options.contentDesc) {
      throw new ActionableError(
        "accessibilityFocus requires a selector: provide one of resourceId, text, or contentDesc."
      );
    }

    const service = this.serviceFactory(this.device);
    const resourceId = await this.resolveResourceId(options);

    try {
      if (action === "clear") {
        await service.clearAccessibilityFocus(resourceId);
      } else {
        await service.setAccessibilityFocus(resourceId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }

    // Confirm the cursor moved (best-effort; never fail the operation on a read error).
    let focusedElement: Element | undefined;
    try {
      const focus = await service.requestCurrentFocus();
      focusedElement = focus.focusedElement ?? undefined;
    } catch (error) {
      logger.warn(`[accessibilityFocus] Failed to read current focus after ${action}: ${error}`);
    }

    return { success: true, focusedElement };
  }

  /**
   * Resolve the target to a resource-id. A resource-id selector is used directly; a
   * text/contentDesc selector is resolved against the current view hierarchy via the
   * element finder. The matched element must itself have a resource-id.
   */
  private async resolveResourceId(options: SetAccessibilityFocusOptions): Promise<string> {
    if (options.resourceId) {
      return options.resourceId;
    }

    const viewHierarchy = await this.getViewHierarchy();
    const matched = this.findElement(viewHierarchy, options);
    const selector = options.text
      ? `text "${options.text}"`
      : `content-desc "${options.contentDesc}"`;
    if (!matched) {
      throw new ActionableError(`Element not found for selector: ${selector}`);
    }

    const resourceId = matched["resource-id"];
    if (!resourceId) {
      throw new ActionableError(
        "Matched element has no resource-id; accessibility focus requires one."
      );
    }

    // The CtrlProxy service can only target a node by resource-id, and it focuses the
    // FIRST node carrying that id. When the resolved id is shared by repeated rows
    // (e.g. a RecyclerView item id reused per row), focusing it would silently move the
    // cursor to the wrong row while reporting success. Reject the ambiguity instead.
    const sharing = this.finder.findElementsByResourceId(viewHierarchy, resourceId);
    if (sharing.length > 1) {
      throw new ActionableError(
        `Selector ${selector} resolved to resource-id "${resourceId}", which is shared by ` +
          `${sharing.length} elements (e.g. repeated list rows). Accessibility focus targets a ` +
          `node by resource-id and would focus the first match, not necessarily the one you ` +
          `selected. Provide a more specific selector or a unique resourceId.`
      );
    }

    return resourceId;
  }

  private async getViewHierarchy(): Promise<ViewHierarchyResult> {
    let observeResult = await this.observeScreen.getMostRecentCachedObserveResult();
    if (!observeResult.viewHierarchy || observeResult.viewHierarchy.hierarchy?.error) {
      observeResult = await this.observeScreen.execute();
    }
    if (!observeResult.viewHierarchy) {
      throw new ActionableError("Unable to observe screen to resolve accessibility focus target.");
    }
    return observeResult.viewHierarchy;
  }

  private findElement(
    viewHierarchy: ViewHierarchyResult,
    options: SetAccessibilityFocusOptions
  ): Element | null {
    if (options.text) {
      return this.finder.findElementByText(viewHierarchy, options.text, undefined, false, false);
    }
    if (options.contentDesc) {
      // content-desc is matched through the text finder (it inspects content-desc too).
      return this.finder.findElementByText(viewHierarchy, options.contentDesc, undefined, false, false);
    }
    return null;
  }
}
