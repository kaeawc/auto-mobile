import type {
  Element,
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
  PRE_RETRY_DELAY_MS,
} from "./androidGhostTapRetry";
import { isTruthyFlag } from "../utility/elementProperties";
import type { DisplayFenceOption } from "./BaseVisualChange";
import type { TapOnElement } from "./TapOnElement";
import type { TapPointPlanner } from "./tapPointPlanner";
import { pointInTapBounds } from "./tapTargetSupport";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";

/** What the ghost-tap retry phase needs from the owning tap action. */
export interface TapRetryHost {
  readonly timer: Timer;
  tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"];
  hashViewHierarchy(hierarchy: ViewHierarchyResult | null): string | null;
  findElementInHierarchy(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult };
  resolveTapTargetElement(
    element: Element,
    hierarchy: ViewHierarchyResult | null,
    action: string,
    targetOptions: { requireResourceId: boolean; scoped: boolean },
  ): { element: Element };
  getScreenSizeFromHierarchy(
    hierarchy: ViewHierarchyResult,
    options?: ScreenSizeForOffscreenCheckOptions,
  ): ObserveResult["screenSize"] | undefined;
  visibleTapBounds: TapPointPlanner["visibleTapBounds"];
  resolveVisibleTapPoint: TapPointPlanner["resolveVisibleTapPoint"];
  executeAndroidTap: TapOnElement["executeAndroidTap"];
}

/** Positional arguments of the owner's retry-if-no-change step. */
export type RetryTapIfNoChangeArgs = [
  preTapHash: string | null,
  tapPoint: { x: number; y: number },
  action: string,
  longPressDuration: number,
  tapElement: Element,
  options: TapVerificationOptions & DisplayFenceOption,
  isTalkBackEnabled: boolean,
  screenSize: ObserveResult["screenSize"],
  signal?: AbortSignal,
  selection?: ElementSelectionResult,
];

/** True when the options carry a text/id/tag selector that can be re-resolved. */
function hasReResolvableSelector(options: TapVerificationOptions): boolean {
  return Boolean(options.text || options.textAny?.length || options.elementId || options.testTag);
}

/**
 * Android ghost-tap recovery: after a tap, check whether the view hierarchy
 * changed; if not, re-resolve the target in the fresh hierarchy and retry once.
 */
export class TapRetryPhase {
  constructor(private readonly host: TapRetryHost) {}

  resolveEnsureCheckedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    requireResourceId: boolean,
  ): Element | null {
    const refound = this.host.findElementInHierarchy(options, hierarchy).selection.element;
    if (!refound || !isTruthyFlag(refound.checkable)) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Toggle not found in fresh hierarchy; skipping retry",
      );
      return null;
    }
    if (isTruthyFlag(refound.checked) === options.ensureChecked) {
      logger.info("[TapOnElement][retryIfNoChange] Toggle reached requested checked state");
      return null;
    }
    return this.host.resolveTapTargetElement(refound, hierarchy, action, {
      requireResourceId,
      scoped: options.container !== undefined,
    }).element;
  }

  withRetryScreenSize(
    options: TapVerificationOptions,
    screenSize: ObserveResult["screenSize"],
  ): TapVerificationOptions {
    return {
      ...options,
      screenSizeOptions: options.screenSizeOptions ?? { observationScreenSize: screenSize },
    };
  }

  refreshedRetrySelection(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    tapElement: Element,
    previous?: ElementSelectionResult,
  ): ElementSelectionResult {
    if (hasReResolvableSelector(options)) {
      return this.host.findElementInHierarchy(options, hierarchy).selection;
    }
    return (
      previous ?? { element: tapElement, indexInMatches: -1, totalMatches: 1, strategy: "first" }
    );
  }

  resolveRefreshedRetryTarget(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    action: string,
    isTalkBackEnabled: boolean,
    selection: ElementSelectionResult,
    previousTarget: Element,
  ): Element | null {
    if (options.ensureChecked !== undefined) {
      return this.resolveEnsureCheckedRetryTarget(options, hierarchy, action, isTalkBackEnabled);
    }
    if (selection.element) {
      return this.host.resolveTapTargetElement(selection.element, hierarchy, action, {
        requireResourceId: isTalkBackEnabled,
        scoped: options.container !== undefined,
      }).element;
    }
    if (hasReResolvableSelector(options)) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Target not found in refreshed hierarchy; skipping retry",
      );
      return null;
    }
    return previousTarget;
  }

  async retryTapIfNoChange(...args: RetryTapIfNoChangeArgs): Promise<void> {
    const [
      preTapHash,
      tapPoint,
      action,
      longPressDuration,
      tapElement,
      options,
      isTalkBackEnabled,
      screenSize,
      signal,
      selection,
    ] = args;
    const probe = await checkAndroidTapHierarchyChange(
      this.host.timer,
      this.host.tapVerificationRefresh({
        refresh: options.verification?.refresh,
        screenSize,
        signal,
      }),
      (hierarchy) => this.host.hashViewHierarchy(hierarchy),
      preTapHash,
      signal,
    );

    if (probe.status === "unavailable") {
      // Hierarchy unreadable — we can't tell whether the tap registered. A retry
      // here is more likely to land on a transitioning screen and bounce us
      // off-path than to recover a real ghost tap. Bail and let the next
      // step's waitFor/observe surface a real failure.
      logger.warn(
        `[TapOnElement][retryIfNoChange] Tap hierarchy unreadable or could not be fingerprinted ` +
          `(post-tap refresh budget ${POST_TAP_REFRESH_TIMEOUT_MS}ms) — skipping retry`,
      );
      return;
    }

    if (probe.status === "changed") {
      logger.info(`[TapOnElement][retryIfNoChange] Hierarchy changed after tap — tap registered`);
      return;
    }

    const retryOptions = this.withRetryScreenSize(options, screenSize);
    const refreshedSelection = this.refreshedRetrySelection(
      retryOptions,
      probe.hierarchy,
      tapElement,
      selection,
    );
    const retryTarget = this.resolveRefreshedRetryTarget(
      retryOptions,
      probe.hierarchy,
      action,
      isTalkBackEnabled,
      refreshedSelection,
      tapElement,
    );
    if (!retryTarget) {
      return;
    }
    const retryScreenSize = this.host.getScreenSizeFromHierarchy(
      probe.hierarchy,
      retryOptions.screenSizeOptions,
    );
    const retryBounds = this.host.visibleTapBounds(
      refreshedSelection.element
        ? refreshedSelection
        : (selection ?? { ...refreshedSelection, element: retryTarget }),
      probe.hierarchy,
      retryScreenSize,
      retryOptions,
      retryTarget,
    );
    if (!retryBounds) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Refreshed target has no visible tap area; skipping retry",
      );
      return;
    }
    const retryPoint = pointInTapBounds(tapPoint, retryBounds)
      ? tapPoint
      : this.host.resolveVisibleTapPoint(retryTarget, probe.hierarchy, retryBounds, {
          options,
          screenSize: retryScreenSize,
        });
    if (!retryPoint) {
      logger.warn(
        "[TapOnElement][retryIfNoChange] Refreshed target has no unobstructed tap point; skipping retry",
      );
      return;
    }
    logger.warn(
      `[TapOnElement][retryIfNoChange] Hierarchy unchanged after tap at ` +
        `(${retryPoint.x}, ${retryPoint.y}) — ghost tap detected, retrying`,
    );

    await this.host.timer.sleep(PRE_RETRY_DELAY_MS);

    if (options.verification?.dispatch) {
      await options.verification.dispatch(retryPoint);
      return;
    }
    await this.host.executeAndroidTap(
      action,
      retryPoint.x,
      retryPoint.y,
      longPressDuration,
      retryTarget,
      signal,
      { ...options, resolvedHierarchy: probe.hierarchy },
      isTalkBackEnabled,
    );
  }
}
