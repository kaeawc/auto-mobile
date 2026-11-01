import { isStrictlyScoped } from "../utility/ScopedSelection";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { freshTapHierarchy } from "./freshTapHierarchy";
import {
  isSemanticActionRejected,
  type TalkBackTargetContext,
} from "../talkback/resourceIdActionError";
import {
  TALKBACK_STATE_UNKNOWN_WARNING,
  resolveTalkBackStateConfirmation,
} from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { DEFAULT_HIERARCHY_READ_TIMEOUT_MS } from "../observe/DeviceHierarchyCapture";
import { resolveDisplayFence, type DisplayFenceOption } from "./BaseVisualChange";
import {
  getHierarchySnapshot,
  identifyObservedHierarchy,
  type HierarchySnapshot,
} from "../observe/HierarchyCapture";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  type Point,
  TapAnyElementOptions,
  ViewHierarchyResult,
  requireAndroidOrIosPlatform,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { type ScreenSizeForOffscreenCheckOptions } from "../utility/ElementGeometry";
import { logger } from "../../utils/logger";
import { type AndroidCtrlProxy, AndroidCtrlProxyClient } from "../observe/android";
import { throwIfAborted } from "../../utils/toolUtils";
import { type Timer } from "../../utils/SystemTimer";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { dispatchAndroidCoordinateTap } from "./coordinateTapDispatch";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import { dispatchAndroidLongPress } from "./androidLongPress";
import {
  requiresNodeSelector,
  stableNodeSelectorForElement,
  TalkBackTapStrategy,
} from "../talkback/TalkBackTapStrategy";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { checkAndroidTapHierarchyChange, PRE_RETRY_DELAY_MS } from "./androidGhostTapRetry";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import { type TalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";

export type TapAnyAccessibilityService = Pick<
  AndroidCtrlProxyClient,
  "requestTapCoordinates" | "requestAction" | "requestNodeAction" | "supportsNodeActionSelectors"
> &
  Partial<Pick<AndroidCtrlProxy, "supportsCommand">>;

export type RefreshViewHierarchy = (
  timeoutMs: number,
  screenSize?: ObserveResult["screenSize"],
  signal?: AbortSignal,
  forceCapture?: boolean,
) => Promise<ViewHierarchyResult | null>;

export interface CapturedTapTarget {
  observationScreenSize?: ObserveResult["screenSize"];
  observationDisplay?: ScreenSizeForOffscreenCheckOptions["display"];
  scoped?: boolean;
  talkBackState?: boolean | null;
  /** The request's `layer`; with none, the tap point must avoid AutoMobile's prototype windows. */
  layer?: HierarchyLayer;
  element: Element;
  capture: HierarchySnapshot;
}

/** Dependencies shared with tapAny selection; callbacks retain the current host/test seams. */
export interface TapAnyAndroidTapperDependencies {
  device: BootedDevice;
  timer: Timer;
  getAdb(): AdbExecutor;
  accessibilityService: TapAnyAccessibilityService;
  accessibilityDetector: AccessibilityDetector;
  featureFlags: FeatureFlagReader;
  talkBackStrategy: Pick<
    TalkBackTapStrategy,
    | "executeDirectActivation"
    | "executeCoordinateFallback"
    | "executeLongPress"
    | "executePreciseTap"
  >;
  talkBackDriverFactory: TalkBackNavigationDriverFactory;
  beforeTap(): void;
  refreshViewHierarchy: RefreshViewHierarchy;
  findClickableElement(
    options: TapAnyElementOptions,
    viewHierarchy: ViewHierarchyResult,
    sizeOptions?: ScreenSizeForOffscreenCheckOptions,
  ): { element: Element | null; containerFound: boolean };
  resolveTapPoint(
    target: CapturedTapTarget,
    sizeOptions?: ScreenSizeForOffscreenCheckOptions,
  ): { x: number; y: number };
}

export function assertSelectedCapture(selectedCapture: HierarchySnapshot): void {
  const dispatchCapture = getHierarchySnapshot(selectedCapture.hierarchy);
  if (
    dispatchCapture?.captureId !== selectedCapture.captureId ||
    dispatchCapture.hierarchy !== selectedCapture.hierarchy
  ) {
    throw new ActionableError("Selected hierarchy capture changed before tap dispatch");
  }
}

/** Android tapAny dispatch, semantic activation and one post-tap retry. */
export class TapAnyAndroidTapper {
  constructor(private readonly deps: TapAnyAndroidTapperDependencies) {}

  async executeAndroidTap(
    action: TapAnyElementOptions["action"],
    point: Point,
    durationMs: number,
    {
      target,
      fenceOptions = {},
    }: {
      target: CapturedTapTarget;
      fenceOptions?: DisplayFenceOption & {
        signal?: AbortSignal;
        onActivationWarnings?: (warnings?: string[]) => void;
      };
    },
  ): Promise<void> {
    const { x, y } = point;
    const { signal } = fenceOptions;
    const fence = resolveDisplayFence(fenceOptions);
    const { element, capture } = target;
    this.deps.beforeTap();
    assertSelectedCapture(capture);
    // UiAutomator captures keep their existing coordinate route, but unavailable
    // TalkBack evidence must still be retried and reported to the caller.
    const { talkBack: talkBackState, unconfirmed } =
      target.talkBackState === undefined
        ? await resolveTalkBackStateConfirmation(
            this.deps.accessibilityDetector,
            this.deps.device.deviceId,
            this.deps.getAdb(),
            this.deps.featureFlags,
          )
        : { talkBack: target.talkBackState, unconfirmed: false };
    if (unconfirmed) {
      fenceOptions.onActivationWarnings?.([TALKBACK_STATE_UNKNOWN_WARNING]);
    }
    const talkBackEnabled = element["hierarchy-source"] !== "uiautomator" && talkBackState === true;
    if (
      talkBackEnabled &&
      (await this.executeAndroidTalkBackTap(action, { x, y }, durationMs, {
        element,
        fenceOptions: {
          displayFence: fence,
          scoped: target.scoped,
          hierarchy: resolveViewHierarchyForSearch(capture.hierarchy),
          onActivationWarnings: fenceOptions.onActivationWarnings,
        },
      }))
    ) {
      return;
    }

    if (action === "longPress") {
      if (await this.trySemanticAndroidLongPress(element, { signal, scoped: target.scoped })) {
        return;
      }
      await this.executeAndroidLongPress(x, y, durationMs, {
        signal,
        fenceOptions: { displayFence: fence },
      });
      return;
    }

    await this.executeAndroidCoordinateTap(
      action,
      { x, y },
      {
        signal,
        fence,
        onActivationWarnings: fenceOptions.onActivationWarnings,
      },
    );
  }

  /** One tap, or a doubleTap whose touches are timed on the device when CtrlProxy supports it. */
  private async executeAndroidCoordinateTap(
    action: TapAnyElementOptions["action"],
    point: { x: number; y: number },
    context: {
      signal?: AbortSignal;
      fence: { assertCurrent(): void };
      onActivationWarnings?: (warnings?: string[]) => void;
    },
  ): Promise<void> {
    const { signal, fence } = context;
    const tapOnce = async () => {
      // Once beforeSend lands, also pass this as the dispatch's beforeSend.
      fence.assertCurrent();
      await dispatchAndroidCoordinateTap(
        this.deps.accessibilityService,
        this.deps.getAdb(),
        point,
        { durationMs: 10, options: { signal } },
      );
    };
    if (action !== "doubleTap") {
      await tapOnce();
      return;
    }
    await dispatchAndroidDoubleTap({
      client: this.deps.accessibilityService,
      point,
      timer: this.deps.timer,
      signal,
      assertCurrent: () => fence.assertCurrent(),
      onWarning: (warning) => context.onActivationWarnings?.([warning]),
      tap: tapOnce,
    });
  }

  private async executeAndroidLongPress(
    x: number,
    y: number,
    durationMs: number,
    { signal, fenceOptions = {} }: { signal?: AbortSignal; fenceOptions?: DisplayFenceOption } = {},
  ): Promise<void> {
    const fence = resolveDisplayFence(fenceOptions);
    throwIfAborted(signal);
    await dispatchAndroidLongPress({
      adb: this.deps.getAdb(),
      x,
      y,
      durationMs,
      signal,
      assertCurrent: () => fence.assertCurrent(),
      logTag: "TapAnyElement",
    });
  }

  private async trySemanticAndroidLongPress(
    element: Element,
    context: { signal?: AbortSignal; scoped?: boolean },
  ): Promise<boolean> {
    const { signal, scoped } = context;
    const selector = stableNodeSelectorForElement(element);
    if (!selector || scoped || element["hierarchy-source"] === "uiautomator") {
      return false;
    }
    const needsNodeSelector = requiresNodeSelector(selector);
    if (
      needsNodeSelector &&
      !(await this.deps.accessibilityService.supportsNodeActionSelectors())
    ) {
      return false;
    }
    try {
      throwIfAborted(signal);
      const result = needsNodeSelector
        ? await this.deps.accessibilityService.requestNodeAction("long_click", selector)
        : await this.deps.accessibilityService.requestAction("long_click", selector.resourceId);
      if (result.success) {
        return true;
      }
      const rejected = await isSemanticActionRejected({
        advertised: hasAccessibilityAction(element.actions, "long_click"),
        error: result.error,
        needsNodeSelector,
        selected: element,
        // A forced fresh capture: the tree the element came from may predate the lookup miss.
        readHierarchy: () =>
          this.deps.refreshViewHierarchy(
            DEFAULT_HIERARCHY_READ_TIMEOUT_MS,
            undefined,
            signal,
            true,
          ),
      });
      throwIfAborted(signal);
      if (rejected) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      logger.warn(`[TapAnyElement] Accessibility long click failed: ${result.error}`);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof ActionableError) {
        throw error;
      }
      logger.warn(`[TapAnyElement] Accessibility long click error: ${error}`);
    }
    return false;
  }

  async executeAndroidTalkBackTap(
    action: TapAnyElementOptions["action"],
    point: Point,
    durationMs: number,
    {
      element,
      fenceOptions = {},
    }: {
      element: Element;
      fenceOptions?: DisplayFenceOption &
        TalkBackTargetContext & {
          scoped?: boolean;
          onActivationWarnings?: (warnings?: string[]) => void;
        };
    },
  ): Promise<boolean> {
    const { x, y } = point;
    const fence = fenceOptions.displayFence;
    const driver = this.deps.talkBackDriverFactory.createDriver(this.deps.device);
    if (action === "longPress" && !fenceOptions.scoped) {
      const result = await this.deps.talkBackStrategy.executeLongPress(
        { x, y },
        durationMs,
        element,
        { driver, fenceOptions: { ...fenceOptions, displayFence: fence } },
      );
      if (!result.success && result.semanticActionFailure) {
        throw new ActionableError(
          `Semantic long press failed for the selected element: ${result.error ?? "unknown error"}`,
        );
      }
      return result.success;
    }
    if (action === "tap" && !fenceOptions.scoped) {
      const direct = await this.deps.talkBackStrategy.executeDirectActivation(
        element,
        driver,
        fenceOptions,
      );
      if (direct.success) {
        return true;
      }
      logger.warn(
        `[TapAnyElement] Direct accessibility activation failed (${direct.error}); trying coordinate fallback`,
      );
    }
    const fallback =
      action === "tap"
        ? await this.deps.talkBackStrategy.executePreciseTap(x, y, driver, fence)
        : await this.deps.talkBackStrategy.executeCoordinateFallback({ x, y }, action, durationMs, {
            driver,
            fenceOptions: {
              displayFence: fence,
            },
          });
    fenceOptions.onActivationWarnings?.(fallback.warnings);
    return fallback.success;
  }

  async retryAndroidTapIfNoChange(
    preTapHash: string | null,
    target: CapturedTapTarget,
    action: TapAnyElementOptions["action"],
    {
      durationMs,
      fenceOptions = {},
    }: {
      durationMs: number;
      fenceOptions?: DisplayFenceOption & {
        screenSize?: ObserveResult["screenSize"];
        signal?: AbortSignal;
        selectionOptions?: TapAnyElementOptions;
        refresh?: RefreshViewHierarchy;
        dispatch?: (point: { x: number; y: number }) => Promise<void>;
        onActivationWarnings?: (warnings?: string[]) => void;
      };
    },
  ): Promise<void> {
    const fence = fenceOptions.displayFence;
    const { signal, screenSize } = fenceOptions;
    const reportedTarget = target;
    if (action !== "tap" || !preTapHash) {
      return;
    }
    const probe = await checkAndroidTapHierarchyChange(
      this.deps.timer,
      (timeoutMs) =>
        (fenceOptions.refresh ?? this.deps.refreshViewHierarchy)(timeoutMs, screenSize, signal),
      (postTapHierarchy) => hierarchyFingerprint(postTapHierarchy),
      { preTapHash, signal },
    );
    if (probe.status === "unavailable") {
      logger.warn(
        "[TapAnyElement] Tap hierarchy unreadable or could not be fingerprinted; skipping retry",
      );
      return;
    }
    if (probe.status === "changed") {
      return;
    }
    const options = fenceOptions.selectionOptions;
    if (options && isStrictlyScoped(options, "any-container")) {
      const capture = identifyObservedHierarchy(
        requireAndroidOrIosPlatform(this.deps.device.platform, "tapAny"),
        probe.hierarchy,
        "cached-ok",
        { timer: this.deps.timer },
      );
      const refound = this.deps.findClickableElement(options, capture.hierarchy, {
        observationScreenSize: screenSize,
      });
      if (!refound.element) {
        return;
      }
      target = { ...target, element: refound.element, capture };
    }
    // The first tap was unobserved. Retry the captured or re-resolved target once after debounce.
    let retryPoint = this.deps.resolveTapPoint(target, { observationScreenSize: screenSize });
    logger.warn(
      `[TapAnyElement] Hierarchy unchanged after tap at (${retryPoint.x}, ${retryPoint.y}); retrying`,
    );
    await this.deps.timer.sleep(PRE_RETRY_DELAY_MS);
    await this.refreshTalkBackRetryTarget(target, options, fenceOptions.refresh, {
      screenSize,
      signal,
    });
    if (target.talkBackState) {
      reportedTarget.element = target.element;
      reportedTarget.capture = target.capture;
    }
    retryPoint = this.deps.resolveTapPoint(target, { observationScreenSize: screenSize });
    if (fenceOptions.dispatch) {
      assertSelectedCapture(target.capture);
      await fenceOptions.dispatch(retryPoint);
      return;
    }
    await this.executeAndroidTap(action, retryPoint, durationMs, {
      target,
      fenceOptions: {
        signal,
        displayFence: fence,
        onActivationWarnings: fenceOptions.onActivationWarnings,
      },
    });
  }

  private async refreshTalkBackRetryTarget(
    target: CapturedTapTarget,
    options: TapAnyElementOptions | undefined,
    refresh: RefreshViewHierarchy | undefined,
    { screenSize, signal }: { screenSize?: ObserveResult["screenSize"]; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!target.talkBackState || !options) {
      return;
    }
    // The debounce wait follows the post-tap probe. Capture after that wait,
    // then use tapAny's existing selector rather than the earlier coordinates.
    const hierarchy = await freshTapHierarchy(
      (timeout) => (refresh ?? this.deps.refreshViewHierarchy)(timeout, screenSize, signal),
      this.deps.timer,
      signal,
    );
    const capture = identifyObservedHierarchy(
      requireAndroidOrIosPlatform(this.deps.device.platform, "tapAny"),
      hierarchy,
      "fresh",
      { timer: this.deps.timer },
    );
    const found = this.deps.findClickableElement(options, capture.hierarchy, {
      observationScreenSize: screenSize,
    });
    if (!found.element) {
      throw new ActionableError(
        "Selected element moved or is gone and no clickable target remains. Observe again before tapping.",
      );
    }
    target.element = found.element;
    target.capture = capture;
  }
}
