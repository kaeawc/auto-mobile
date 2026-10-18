import type { Element } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import type { AndroidCtrlProxyClient } from "../observe/android";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { isSemanticActionRejected } from "../talkback/resourceIdActionError";
import {
  nodeActionTargetError,
  requiresNodeSelector,
  stableNodeSelectorForElement,
} from "../talkback/TalkBackTapStrategy";
import { dispatchAndroidLongPress } from "./androidLongPress";
import type { ResolvedAndroidTapOptions } from "./tapAndroidDispatchPhase";

/** Positional arguments of the Android long press; the last three are optional. */
export type AndroidLongPressArgs = [
  x: number,
  y: number,
  durationMs: number,
  element: Element,
  signal?: AbortSignal,
  skipSemanticAction?: boolean,
  fenceOptions?: ResolvedAndroidTapOptions,
];

/** What the Android long-press phase needs from the owning tap action. */
export interface TapAndroidLongPressHost {
  adb(): AdbExecutor;
  accessibilityService(): AndroidCtrlProxyClient;
}

/**
 * Android long press for tapOn: a semantic long_click when the element has a
 * stable node selector, otherwise a coordinate long press over ADB.
 */
export class TapAndroidLongPressPhase {
  constructor(private readonly host: TapAndroidLongPressHost) {}

  async executeAndroidLongPress(...args: AndroidLongPressArgs): Promise<void> {
    const [x, y, durationMs, element, signal, skipSemanticAction = false, fenceOptions = {}] = args;
    const fence = fenceOptions.displayFence;
    throwIfAborted(signal);
    if (!skipSemanticAction) {
      const selector = stableNodeSelectorForElement(element);
      if (
        selector &&
        (await this.trySemanticAndroidLongPress(element, selector, signal, fenceOptions))
      ) {
        return;
      }
    }

    await dispatchAndroidLongPress({
      adb: this.host.adb(),
      x,
      y,
      durationMs,
      signal,
      assertCurrent: fence ? () => fence.assertCurrent() : undefined,
      logTag: "TapOnElement",
    });
  }

  semanticAndroidLongPressTargetError(
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<string | undefined> {
    // Raw search resolves against a filtered projection that may omit duplicate IDs.
    // Default extraction matches the cached tree already accepted by this guard.
    const resolvedHierarchy = resolveViewHierarchyForSearch(options.resolvedHierarchy);
    return nodeActionTargetError(selector, {
      supportsNodeActionSelectors: () =>
        this.host.accessibilityService().supportsNodeActionSelectors(),
      getAccessibilityHierarchy: () =>
        resolvedHierarchy
          ? Promise.resolve(resolvedHierarchy)
          : this.host
              .accessibilityService()
              .getAccessibilityHierarchy(undefined, undefined, true, undefined, true, signal),
    });
  }

  async trySemanticAndroidLongPress(
    element: Element,
    selector: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>,
    signal?: AbortSignal,
    options: ResolvedAndroidTapOptions = {},
  ): Promise<boolean> {
    const needsNodeSelector = requiresNodeSelector(selector);
    const targetError = await this.semanticAndroidLongPressTargetError(selector, signal, options);
    // The hierarchy reader turns cancellation into null; never degrade it to a press.
    throwIfAborted(signal);
    if (targetError) {
      logger.info(`[TapOnElement] ${targetError}; using coordinate long press`);
      return false;
    }

    try {
      const result = needsNodeSelector
        ? await this.host.accessibilityService().requestNodeAction("long_click", selector)
        : await this.host.accessibilityService().requestAction("long_click", selector.resourceId);
      if (result.success) {
        return true;
      }
      const rejected = await isSemanticActionRejected({
        advertised: hasAccessibilityAction(element.actions, "long_click"),
        error: result.error,
        needsNodeSelector,
        selected: element,
        // Fresh and unfiltered, like the target guard: the cached tree may predate the miss.
        readHierarchy: () =>
          this.host
            .accessibilityService()
            .getAccessibilityHierarchy(undefined, undefined, true, undefined, true, signal),
      });
      // The hierarchy reader turns cancellation into null; never degrade it to a press.
      throwIfAborted(signal);
      if (rejected) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      logger.warn(`[TapOnElement] Accessibility long click failed: ${result.error}`);
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      logger.warn(`[TapOnElement] Accessibility long click error: ${error}`);
    }
    return false;
  }
}
