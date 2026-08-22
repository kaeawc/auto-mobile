import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  TapAnyElementOptions,
  TapOnElementResult,
  ViewHierarchyResult
} from "../../models";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { DefaultElementSelector } from "../utility/DefaultElementSelector";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { Timer } from "../../utils/SystemTimer";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import { refreshAndroidViewHierarchy } from "./refreshAndroidViewHierarchy";
import { NodeCryptoService } from "../../utils/crypto";

interface TapAnyElementDependencies {
  timer?: Timer;
  elementSelector?: ElementSelector;
}

export class TapAnyElement extends BaseVisualChange {
  private geometry: ElementGeometry;
  private elementSelector: ElementSelector;
  private finder: ElementFinder;
  private accessibilityService: AndroidCtrlProxyClient;
  private viewHierarchy: ViewHierarchy;

  private static readonly SEARCH_UNTIL_DEFAULT_MS = 1500;
  private static readonly SEARCH_UNTIL_MIN_MS = 100;
  private static readonly SEARCH_UNTIL_MAX_MS = 12000;
  private static readonly SEARCH_POLL_INTERVAL_MS = 100;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    options: TapAnyElementDependencies = {}
  ) {
    super(device, adb, options.timer);
    this.geometry = new DefaultElementGeometry();
    this.elementSelector = options.elementSelector ?? new DefaultElementSelector();
    this.finder = new DefaultElementFinder();
    this.accessibilityService = AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.viewHierarchy = new ViewHierarchy(device, this.adbFactory);
  }

  private createErrorResult(action: string, error: string): TapOnElementResult {
    return {
      success: false,
      action,
      error,
      element: {
        bounds: { left: 0, top: 0, right: 0, bottom: 0 }
      } as Element
    };
  }

  private validateOptions(options: TapAnyElementOptions): string | null {
    if (options.container) {
      const containerSelectorCount = [options.container.elementId, options.container.text].filter(Boolean).length;
      if (containerSelectorCount !== 1) {
        return "tapAny container must specify exactly one of elementId or text";
      }
    }
    return null;
  }

  private getSearchUntilDuration(options: TapAnyElementOptions): number {
    const duration = options.searchUntil?.duration ?? TapAnyElement.SEARCH_UNTIL_DEFAULT_MS;
    if (!Number.isFinite(duration)) {
      throw new ActionableError("searchUntil.duration must be a number");
    }
    if (duration < TapAnyElement.SEARCH_UNTIL_MIN_MS) {
      throw new ActionableError(`searchUntil.duration must be at least ${TapAnyElement.SEARCH_UNTIL_MIN_MS}ms`);
    }
    if (duration > TapAnyElement.SEARCH_UNTIL_MAX_MS) {
      throw new ActionableError(`searchUntil.duration must be at most ${TapAnyElement.SEARCH_UNTIL_MAX_MS}ms`);
    }
    return Math.round(duration);
  }

  private isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string }
  ): boolean {
    if (!container) {return true;}
    return this.finder.hasContainerElement(viewHierarchy, container);
  }

  private isElementCenterOffScreen(
    element: Element,
    screenSize?: ObserveResult["screenSize"]
  ): boolean {
    if (!screenSize?.width || !screenSize?.height || !element.bounds) {
      return false;
    }
    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    return centerX < 0 || centerX > screenSize.width ||
           centerY < 0 || centerY > screenSize.height;
  }

  private findClickableElement(
    options: TapAnyElementOptions,
    viewHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"]
  ): { element: Element | null; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);
    const selection = this.elementSelector.selectClickable(viewHierarchy, {
      container: options.container,
      strategy: options.selectionStrategy,
      scrollableContainer: options.scrollableContainer
    });
    if (selection.element && this.isElementCenterOffScreen(selection.element, screenSize)) {
      return { element: null, containerFound };
    }
    return { element: selection.element, containerFound };
  }

  private hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    if (!viewHierarchy) {return null;}
    try {
      return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy.hierarchy));
    } catch (error) {
      // Hashing is only used to key an optional cache lookup; if JSON.stringify or the
      // hash fails on a malformed hierarchy, skip the cache instead of failing the tap.
      logger.debug(`src/features/action/TapAnyElement.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"]
  ): ViewHierarchyResult {
    if (!serverConfig.isRawElementSearchEnabled()) {
      return rawHierarchy;
    }
    if (
      rawHierarchy?.hierarchy &&
      typeof rawHierarchy.hierarchy === "object" &&
      "error" in rawHierarchy.hierarchy &&
      rawHierarchy.hierarchy.error
    ) {
      return rawHierarchy;
    }
    if (this.device.platform === "android") {
      const filtered = this.viewHierarchy.filterViewHierarchy(rawHierarchy);
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }
    if (this.device.platform === "ios" && screenSize?.width && screenSize?.height) {
      const filtered = this.viewHierarchy.filterOffscreenNodes(
        rawHierarchy,
        screenSize.width,
        screenSize.height
      );
      attachRawViewHierarchy(filtered, rawHierarchy);
      return filtered;
    }
    return rawHierarchy;
  }

  private async refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal
  ): Promise<ViewHierarchyResult | null> {
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    switch (this.device.platform) {
      case "android": {
        const rawHierarchy = await refreshAndroidViewHierarchy(
          this.accessibilityService,
          this.viewHierarchy,
          effectiveTimeoutMs,
          signal
        );
        return rawHierarchy
          ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize)
          : null;
      }
      case "ios": {
        const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
        const rawHierarchy = await xcTestClient.getAccessibilityHierarchy();
        return rawHierarchy
          ? this.prepareViewHierarchyForResponse(rawHierarchy, screenSize)
          : null;
      }
      default:
        throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
    }
  }

  private getLongPressDuration(options: TapAnyElementOptions): number {
    if (options.action !== "longPress") {return 0;}
    if (options.duration && options.duration > 0) {return options.duration;}
    return this.device.platform === "ios" ? 1500 : 1000;
  }

  async execute(
    options: TapAnyElementOptions,
    progress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<TapOnElementResult> {
    if (!options.action) {
      return this.createErrorResult(options.action, "tap action is required");
    }

    const validationError = this.validateOptions(options);
    if (validationError) {
      return this.createErrorResult(options.action, validationError);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("tapAnyElement");

    try {
      throwIfAborted(signal);

      const result = await this.observedInteraction(
        async (observeResult: ObserveResult) => {
          throwIfAborted(signal);

          const viewHierarchy = observeResult.viewHierarchy;
          if (!viewHierarchy) {
            perf.end();
            return { success: false, error: "Unable to get view hierarchy, cannot tap on element" };
          }

          const searchDurationMs = this.getSearchUntilDuration(options);
          const startTime = this.timer.now();
          let requestCount = 0;
          let changeCount = 0;
          let lastHash = this.hashViewHierarchy(viewHierarchy);

          let found = this.findClickableElement(options, viewHierarchy, observeResult.screenSize);
          let element = found.element;
          let containerFoundEver = found.containerFound;

          if (!element) {
            const deadline = startTime + searchDurationMs;
            while (this.timer.now() < deadline) {
              throwIfAborted(signal);
              await this.timer.sleep(TapAnyElement.SEARCH_POLL_INTERVAL_MS);
              const remainingTimeMs = Math.max(0, deadline - this.timer.now());
              if (remainingTimeMs <= 0) {break;}
              const refreshed = await this.refreshViewHierarchy(
                remainingTimeMs,
                observeResult.screenSize,
                signal
              );
              requestCount += 1;
              if (!refreshed) {continue;}

              const hash = this.hashViewHierarchy(refreshed);
              if (hash && hash !== lastHash) {
                changeCount += 1;
                lastHash = hash;
              }

              found = this.findClickableElement(options, refreshed, observeResult.screenSize);
              element = found.element;
              containerFoundEver = containerFoundEver || found.containerFound;
              if (element) {break;}
            }
          }

          if (!element) {
            if (options.container && !containerFoundEver) {
              const containerLabel = options.container.elementId
                ? `elementId '${options.container.elementId}'`
                : `text '${options.container.text}'`;
              throw new ActionableError(`Container element not found with provided ${containerLabel}`);
            }
            const containerHint = options.container
              ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
              : "";
            throw new ActionableError(`No clickable element found${containerHint}`);
          }

          const tapPoint = this.geometry.getElementCenter(element);
          const action = options.action;
          const longPressDuration = this.getLongPressDuration(options);

          logger.info(
            `[TapAnyElement] Tapping (${tapPoint.x}, ${tapPoint.y}) on clickable element: ` +
            `text=${JSON.stringify(element.text)}, ` +
            `bounds=${JSON.stringify(element.bounds)}`
          );

          switch (this.device.platform) {
            case "android":
              if (action === "longPress") {
                await this.adb.executeCommand(`shell input swipe ${tapPoint.x} ${tapPoint.y} ${tapPoint.x} ${tapPoint.y} ${longPressDuration}`);
              } else if (action === "doubleTap") {
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
                await this.timer.sleep(50);
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
              } else {
                await this.adb.executeCommand(`shell input tap ${tapPoint.x} ${tapPoint.y}`);
              }
              break;
            case "ios": {
              const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
              if (action === "longPress") {
                await xcTestClient.longPress(tapPoint.x, tapPoint.y, longPressDuration / 1000);
              } else if (action === "doubleTap") {
                await xcTestClient.doubleTap(tapPoint.x, tapPoint.y);
              } else {
                await xcTestClient.tap(tapPoint.x, tapPoint.y);
              }
              break;
            }
            default:
              throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
          }

          perf.end();
          return {
            success: true,
            action,
            element,
            searchUntil: {
              durationMs: Math.max(0, Math.round(this.timer.now() - startTime)),
              requestCount,
              changeCount
            }
          };
        },
        {
          changeExpected: false,
          timeoutMs: 800,
          progress,
          perf,
          signal,
          predictionContext: {
            toolName: "tapAny",
            toolArgs: {
              action: options.action,
              duration: options.duration,
              container: options.container,
              selectionStrategy: options.selectionStrategy,
              scrollableContainer: options.scrollableContainer,
              platform: this.device.platform
            }
          }
        }
      );

      return result;
    } catch (error) {
      perf.end();
      const errorMsg = errorMessage(error);
      return {
        success: false,
        action: options.action,
        error: `Failed to tap clickable element: ${errorMsg}`,
        element: {
          bounds: { left: 0, top: 0, right: 0, bottom: 0 }
        } as Element
      };
    }
  }
}
