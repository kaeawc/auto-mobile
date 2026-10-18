import {
  ActionableError,
  type ElementSelectionResult,
  type ObserveResult,
  type TapOnElementResult,
  type ViewHierarchyResult,
} from "../../models";
import { hasOwnPrototype, scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  getVisionEnrichedError,
  type VisionAnalyzer,
  type VisionFallbackConfig,
} from "../../vision/index";
import type { ScreenshotCapturer } from "../navigation/SelectionStateTracker";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { pollSearchUntil } from "./searchUntilPoller";
import type { TapPointPlanner } from "./tapPointPlanner";
import { TapTargetUnavailableError } from "./tapTargetSupport";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";

export type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** Poll cadence of the searchUntil refresh loop. */
export const SEARCH_POLL_INTERVAL_MS = 50;

/** What the element-search phase needs from the owning tap action. */
export interface TapSearchHost {
  readonly timer: Timer;
  visionConfig(): VisionFallbackConfig;
  screenshotCapturer(): ScreenshotCapturer;
  visionAnalyzer(): VisionAnalyzer | undefined;
  getSearchUntilDuration(options: TapOnElementOptions): number;
  hashViewHierarchy(hierarchy: ViewHierarchyResult | null): string | null;
  getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"];
  invisibleMatchFailure: TapPointPlanner["invisibleMatchFailure"];
  isElementTapTargetOffScreen: TapPointPlanner["isElementTapTargetOffScreen"];
  findElementInHierarchy(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult; containerFound: boolean };
  withObservationScreenSize(
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ): TapVerificationOptions;
  tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"];
}

/**
 * Element search for tapOn: the searchUntil refresh-and-retry loop (including
 * off-screen target rejection) and the not-found error construction.
 */
export class TapSearchPhase {
  constructor(private readonly host: TapSearchHost) {}

  private isPrototypeWindowPending(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): boolean {
    return (
      options.layer === "prototype" &&
      hierarchy.prototypeSuspended !== true &&
      !hasOwnPrototype(hierarchy)
    );
  }

  findElementForSearch(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): ReturnType<TapSearchHost["findElementInHierarchy"]> {
    if (this.isPrototypeWindowPending(options, hierarchy)) {
      // A successful show can precede the window's first accessibility capture.
      return {
        selection: { element: null, indexInMatches: -1, totalMatches: 0, strategy: "first" },
        containerFound: false,
      };
    }
    return this.host.findElementInHierarchy(options, hierarchy);
  }

  async searchForElement(
    options: TapVerificationOptions,
    observeResult: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{
    selection: ElementSelectionResult;
    viewHierarchy: ViewHierarchyResult;
    containerFound: boolean;
    stats: SearchUntilStats;
    /**
     * True when `viewHierarchy` is a genuine live device re-capture taken during
     * this search (the caller's initial hierarchy did not already contain the
     * target), distinct from the common case where the element was found in the
     * hierarchy the caller already had with no device round-trip. Drives
     * whether {@link replaceObservationHierarchy} also realigns freshness
     * (issue #6284).
     */
    refreshedFromDevice: boolean;
    visibilityError?: TapTargetUnavailableError;
  }> {
    const viewHierarchy = observeResult.viewHierarchy;
    if (!viewHierarchy) {
      throw new ActionableError("Unable to get view hierarchy, cannot tap on element");
    }

    const searchDurationMs = this.host.getSearchUntilDuration(options);
    const startTime = this.host.timer.now();
    let requestCount = 0;
    let changeCount = 0;
    let offScreenRejections = 0;
    let visibilityError: TapTargetUnavailableError | undefined;
    let lastHash = this.host.hashViewHierarchy(viewHierarchy);

    let latestViewHierarchy = viewHierarchy;
    let latestScreenSize = this.host.getScreenSizeFromHierarchy(latestViewHierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    const initialSearch = this.findElementForSearch(
      this.host.withObservationScreenSize(options, observeResult),
      latestViewHierarchy,
    );
    let selection = initialSearch.selection;
    const invisibleError = () =>
      this.host.invisibleMatchFailure(selection, options, latestViewHierarchy, latestScreenSize);
    let element = selection.element;
    let containerFoundEver = initialSearch.containerFound;
    if (!element && selection.matchedElement) {
      visibilityError = invisibleError();
    }

    if (
      !element ||
      this.host.isElementTapTargetOffScreen(
        selection,
        latestViewHierarchy,
        latestScreenSize,
        options,
      )
    ) {
      if (element) {
        visibilityError = invisibleError();
        logger.warn(
          `[TapOnElement] Element found but tap target is off-screen, will retry. ` +
            `bounds=${JSON.stringify(element.bounds)}, ` +
            `screen=${latestScreenSize?.width}x${latestScreenSize?.height}`,
        );
        selection = { ...selection, element: null };
        element = null;
        offScreenRejections += 1;
      }
      // Fast cached iOS responses must yield just like device round-trips.
      // Keep an independent request ceiling even if the wall clock moves backward.
      const polled = await pollSearchUntil({
        timer: this.host.timer,
        startTime,
        durationMs: searchDurationMs,
        intervalMs: SEARCH_POLL_INTERVAL_MS,
        pacing: "cadence",
        maxRequests: Math.ceil(searchDurationMs / SEARCH_POLL_INTERVAL_MS),
        discardLateResult: false,
        signal,
        fetch: (remainingTimeMs) =>
          this.host.tapVerificationRefresh({
            refresh: options.verification?.refresh,
            screenSize: latestScreenSize,
            signal,
          })(remainingTimeMs),
        accept: (refreshedHierarchy) => {
          latestScreenSize = this.host.getScreenSizeFromHierarchy(refreshedHierarchy, {
            observationScreenSize: latestScreenSize,
            display: latestViewHierarchy,
          });
          latestViewHierarchy = refreshedHierarchy;
          const hash = this.host.hashViewHierarchy(refreshedHierarchy);
          // A first non-null hash after a null one also differs from `lastHash`.
          if (hash && hash !== lastHash) {
            changeCount += 1;
            lastHash = hash;
          }

          const searchResult = this.findElementForSearch(
            {
              ...options,
              screenSizeOptions: {
                observationScreenSize: latestScreenSize,
                display: latestViewHierarchy,
              },
            },
            refreshedHierarchy,
          );
          selection = searchResult.selection;
          element = selection.element;
          containerFoundEver = containerFoundEver || searchResult.containerFound;
          if (!element && selection.matchedElement) {
            visibilityError = invisibleError();
          }
          if (
            element &&
            this.host.isElementTapTargetOffScreen(
              selection,
              refreshedHierarchy,
              latestScreenSize,
              options,
            )
          ) {
            visibilityError = invisibleError();
            logger.warn(
              `[TapOnElement] Element found but tap target is off-screen, retrying. ` +
                `bounds=${JSON.stringify(element.bounds)}`,
            );
            selection = { ...selection, element: null };
            element = null;
            offScreenRejections += 1;
            return false;
          }
          return element !== null;
        },
      });
      requestCount = polled.requestCount;
    }

    if (this.isPrototypeWindowPending(options, latestViewHierarchy)) {
      scopeHierarchyForSelector(latestViewHierarchy, options.layer);
    }

    if (offScreenRejections > 0 && !element) {
      logger.warn(
        `[TapOnElement] Element was found ${offScreenRejections} time(s) but had no visible tap area. ` +
          "Scroll it into view before retrying.",
      );
    }

    const stats: SearchUntilStats = {
      durationMs: Math.max(0, Math.round(this.host.timer.now() - startTime)),
      requestCount,
      changeCount,
    };

    return {
      selection,
      viewHierarchy: latestViewHierarchy,
      containerFound: containerFoundEver,
      stats,
      // `latestViewHierarchy` only diverges from the caller's `viewHierarchy`
      // when a refresh-loop iteration replaced it with a live device re-capture;
      // the target being present in the initial hierarchy returns it unchanged.
      refreshedFromDevice: latestViewHierarchy !== viewHierarchy,
      ...(visibilityError && !element ? { visibilityError } : {}),
    };
  }

  async handleElementNotFound(
    options: TapOnElementOptions,
    observeResult?: ObserveResult,
    containerFound: boolean = true,
    signal?: AbortSignal,
    selection?: ElementSelectionResult,
  ): Promise<never> {
    if (options.container && !containerFound) {
      const containerLabel = options.container.elementId
        ? `elementId '${options.container.elementId}'`
        : `text '${options.container.text}'`;
      throw new ActionableError(
        options.container.elementId?.startsWith("s2-")
          ? `Container element id '${options.container.elementId}' is stale; re-observe and use the id from the new observation.`
          : `Container element not found with provided ${containerLabel}`,
      );
    }

    const containerHint = options.container
      ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
      : "";

    let baseError: string;
    if (options.sibling && options.text) {
      baseError = `No clickable sibling found next to element with text '${options.text}'${containerHint}`;
    } else if (options.sibling && options.elementId) {
      baseError = `No clickable sibling found next to element with elementId '${options.elementId}'${containerHint}`;
    } else if (options.text) {
      baseError = `Element not found with provided text '${options.text}'${containerHint}`;
    } else if (options.textAny) {
      baseError = `Element not found with any provided text '${options.textAny.join("', '")}'${containerHint}`;
    } else if (options.testTag) {
      baseError = `Element not found with provided testTag '${options.testTag}'${containerHint}`;
    } else if (options.accessibilityLink) {
      baseError = `Element not found with provided accessibilityLink '${options.accessibilityLink}'${containerHint}`;
    } else {
      baseError = options.elementId?.startsWith("s2-")
        ? `Element id '${options.elementId}' is stale; re-observe and use the id from the new observation.${containerHint}`
        : `Element not found with provided elementId '${options.elementId}'${containerHint}`;
    }

    if (selection?.onlyKeyboardKeyMatch) {
      throw new TapTargetUnavailableError(
        `${baseError}. The only match is a soft-keyboard key, which observe does not list; ` +
          "use sendKeys or pressButton to drive the keyboard, or dismiss the keyboard first.",
        "not-found",
      );
    }

    if (this.host.visionConfig().enabled && observeResult) {
      logger.info("🔍 Element not found after polling, trying vision fallback...");
      const enrichedMsg = await getVisionEnrichedError(
        this.host.screenshotCapturer(),
        observeResult.viewHierarchy,
        {
          text: options.text ?? options.textAny?.join(" | "),
          resourceId: options.elementId,
          description: `Interactive element for tapping (action: ${options.action})`,
        },
        this.host.visionConfig(),
        baseError,
        signal,
        this.host.visionAnalyzer(),
      );
      throw new TapTargetUnavailableError(enrichedMsg, "not-found");
    }

    throw new TapTargetUnavailableError(baseError, "not-found");
  }
}
