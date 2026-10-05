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

import { errorMessage } from "../../utils/describeUnknownError";
import {
  ActionableError,
  BootedDevice,
  CurrentFocusResult,
  Element,
  SetAccessibilityFocusOptions,
  SetAccessibilityFocusResult,
  ViewHierarchyResult,
} from "../../models";
import { ElementResolver, type ElementResolution } from "../utility/ElementResolver";
import { normalizeQuotes } from "../utility/TextMatcher";
import { SearchableHierarchy } from "../utility/SearchableNode";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../observe/android";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { BaseVisualChange } from "../action/BaseVisualChange";

/**
 * Minimal accessibility-focus capability surface, so this feature can be unit-tested
 * with a fake instead of a real device/WebSocket.
 */
export interface AccessibilityFocusService {
  setAccessibilityFocus(resourceId: string): Promise<void>;
  clearAccessibilityFocus(resourceId: string): Promise<void>;
  requestCurrentFocus(): Promise<CurrentFocusResult>;
}

function matchedTextNativeId(
  resolution: ElementResolution,
  text: string,
  contentDescription = false,
): string | undefined {
  const matched = resolution.matches.find(({ node }) => node === resolution.chosen);
  const query = normalizeQuotes(text).trim().toLowerCase();
  return matched?.sourceNodes?.find(
    (node) =>
      node.nativeId &&
      (contentDescription
        ? [node.textSources["content-desc"], node.accessibleLabel]
        : Object.values(node.textSources)
      ).some((value) => {
        const source = value && normalizeQuotes(value).trim().toLowerCase();
        return resolution.matchMode === "contains" ? source?.includes(query) : source === query;
      }),
  )?.nativeId;
}

function selectedNativeId(
  resolution: ElementResolution,
  options: SetAccessibilityFocusOptions,
): string | undefined {
  if (options.resourceId) {
    return resolution.chosen?.nativeId;
  }
  if (options.text) {
    return matchedTextNativeId(resolution, options.text);
  }
  return options.contentDesc
    ? matchedTextNativeId(resolution, options.contentDesc, true)
    : undefined;
}

export interface SetAccessibilityFocusDependencies {
  resolver?: Pick<ElementResolver, "resolve">;
  observeScreen?: ObserveScreen;
  /** Factory so production resolves the live CtrlProxy client lazily; fakes inject directly. */
  serviceFactory?: (device: BootedDevice) => AccessibilityFocusService;
}

export class SetAccessibilityFocus {
  private readonly device: BootedDevice;
  private readonly resolver: Pick<ElementResolver, "resolve">;
  private readonly searchable = new SearchableHierarchy();
  private readonly observeScreen: ObserveScreen;
  private readonly serviceFactory: (device: BootedDevice) => AccessibilityFocusService;

  constructor(device: BootedDevice, deps: SetAccessibilityFocusDependencies = {}) {
    this.device = device;
    this.resolver = deps.resolver ?? new ElementResolver();
    this.observeScreen =
      deps.observeScreen ?? new RealObserveScreen(device, defaultAdbClientFactory);
    this.serviceFactory =
      deps.serviceFactory ??
      ((d: BootedDevice) => AndroidCtrlProxyClient.getInstance(d, defaultAdbClientFactory));
  }

  async execute(options: SetAccessibilityFocusOptions): Promise<SetAccessibilityFocusResult> {
    if (this.device.platform !== "android") {
      throw new ActionableError(
        "accessibilityFocus is only supported on Android (TalkBack). iOS VoiceOver focus is not yet implemented.",
      );
    }

    const action = options.action ?? "set";

    if (!options.resourceId && !options.text && !options.contentDesc) {
      throw new ActionableError(
        "accessibilityFocus requires a selector: provide one of resourceId, text, or contentDesc.",
      );
    }

    const resourceId = await this.resolveResourceId(options);
    const service = this.serviceFactory(this.device);

    try {
      if (action === "clear") {
        await service.clearAccessibilityFocus(resourceId);
      } else {
        await service.setAccessibilityFocus(resourceId);
      }
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[accessibilityFocus] Failed to ${action} focus: ${errorMessage(error)}`, error);
      return { success: false, error: message };
    }

    // Confirm the cursor moved (best-effort; never fail the operation on a read
    // error). `confirmed` records whether the read-back actually succeeded so
    // callers can distinguish "focused, couldn't confirm" from "didn't focus"
    // (#3922).
    let focusedElement: Element | undefined;
    let confirmed = false;
    try {
      const focus = await service.requestCurrentFocus();
      focusedElement = focus.focusedElement ?? undefined;
      confirmed = true;
    } catch (error) {
      logger.warn(`[accessibilityFocus] Failed to read current focus after ${action}: ${error}`);
    }

    const warning = confirmed
      ? undefined
      : `Focus ${action} was dispatched but the resulting focus state could not be read back to confirm it.`;
    return { success: true, focusedElement, confirmed, warning };
  }

  /** Resolve observed identity locally; only a unique real native ID crosses the service boundary. */
  private async resolveResourceId(options: SetAccessibilityFocusOptions): Promise<string> {
    const hierarchy = await this.getViewHierarchy();
    const nodes = this.searchable.project(hierarchy);
    const selector = options.resourceId
      ? { elementId: options.resourceId }
      : options.text
        ? { text: options.text, match: "exact" as const }
        : { contentDescription: options.contentDesc, match: "exact" as const };
    const resolution = this.resolver.resolve(
      { id: String(hierarchy.updatedAt ?? "accessibility-focus"), nodes },
      selector,
      !options.resourceId && (options.text || options.contentDesc)
        ? { action: "inspect", requireBounds: true }
        : { action: "accessibility-focus", requireResourceId: true },
    );
    if (resolution.error) {
      throw new ActionableError(resolution.error);
    }
    const resourceId = selectedNativeId(resolution, options);
    if (!resourceId) {
      if (
        resolution.matches.some(({ node, sourceNodes }) =>
          (sourceNodes ?? [node]).some((source) => !source.nativeId),
        )
      ) {
        throw new ActionableError(
          "Matched element has no resource-id; accessibility focus requires one.",
        );
      }
      throw new ActionableError(
        `Element not found for accessibility focus selector: ${JSON.stringify(selector)}`,
      );
    }
    const sharing = new Set(
      nodes
        .filter(
          (node) => node.nativeId === resourceId || node.nativeId?.endsWith(`:id/${resourceId}`),
        )
        .map((node) => node.source),
    ).size;
    if (sharing > 1) {
      throw new ActionableError(
        `Selected resource-id "${resourceId}" is shared by ${sharing} elements. Accessibility focus requires a unique native target.`,
      );
    }
    return resourceId;
  }

  private async getViewHierarchy(): Promise<ViewHierarchyResult> {
    let observeResult = await this.observeScreen.getMostRecentCachedObserveResult();
    const hasUsableCache = Boolean(
      observeResult.viewHierarchy && !observeResult.viewHierarchy.hierarchy.error,
    );
    const staleCachedRefetch =
      hasUsableCache && BaseVisualChange.shouldRefetchCachedObservation(observeResult);
    if (staleCachedRefetch) {
      try {
        observeResult = await this.observeScreen.execute({ freshness: "fresh" });
      } catch (error) {
        throw new ActionableError(
          "Unable to observe screen to resolve accessibility focus target.",
          {
            cause: error,
          },
        );
      }
    } else if (!hasUsableCache) {
      observeResult = await this.observeScreen.execute();
    }
    if (
      !observeResult.viewHierarchy ||
      (staleCachedRefetch && observeResult.viewHierarchy.hierarchy?.error)
    ) {
      throw new ActionableError("Unable to observe screen to resolve accessibility focus target.");
    }
    return observeResult.viewHierarchy;
  }
}
