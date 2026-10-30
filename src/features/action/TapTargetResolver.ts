import type { TapOnCall } from "./ActionCall";
import { TapTargetUnavailableError, findTapTargetNode } from "./tapTargetSupport";
import { TapElementFinder } from "./tapElementFinder";
import { TapPointPlanner } from "./tapPointPlanner";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";
import { isStrictlyScoped } from "../utility/ScopedSelection";
import {
  resolveAndroidStableTapTarget,
  type StableTapTargetResult,
} from "./androidStableTapTarget";
import { pollSearchUntil } from "./searchUntilPoller";
import { FocusVerifier, type FocusVerificationHints } from "./tapFocusVerifier";
import { readFreshPlatformHierarchy, returnsRawHierarchyUnfiltered } from "./tapHierarchyRead";
import { POST_TAP_EFFECT_POLL_MS } from "./tapPostTapSettler";
import { resolveSearchUntilDuration } from "./tapSharedHelpers";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import { ElementResolver, promoteClickableAncestor } from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import { errorMessage } from "../../utils/describeUnknownError";
import { getHierarchySnapshot, type HierarchyCapture } from "../observe/HierarchyCapture";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  TapOnElementResult,
  TapOnSelectedElement,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import {
  type DisplayTransitionReader,
  type DisplayTransitionTracker,
} from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import { isUsableScreenSize } from "../utility/ElementGeometry";
import { logger } from "../../utils/logger";
import {
  getVisionEnrichedError,
  type VisionAnalyzer,
  type VisionFallbackConfig,
} from "../../vision/index";
import { throwIfAborted } from "../../utils/toolUtils";
import {
  SelectionCaptureState,
  SelectionStateTracker,
  type ScreenshotCapturer,
} from "../navigation/SelectionStateTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { type Timer } from "../../utils/SystemTimer";
import { boundsEqual } from "../../utils/bounds";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { ViewHierarchy } from "../observe/ViewHierarchy";
import { TapEnsureCheckedPhase } from "./tapEnsureCheckedPhase";
import { TapPostTapEffectPhase } from "./tapPostTapEffectPhase";
import { hasOwnPrototype, scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isTruthyFlag,
} from "../utility/elementProperties";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import type { RenderedDisplayRevisionReader } from "./BaseVisualChange";
import type { TapOnElement } from "./TapOnElement";
import { deriveInteractionEffect } from "./interactionEffect";
import type { TapOnCtrlProxy } from "./tapHierarchyRead";

const IOS_FOCUS_SETTLE_TIMEOUT_MS = 1500;
const SEARCH_POLL_INTERVAL_MS = 50;
const SEARCH_UNTIL_DEFAULT_MS = 1500;
const SEARCH_UNTIL_MIN_MS = 100;
const SEARCH_UNTIL_MAX_MS = 12000;
type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** Capabilities used by this phase; dependency readers observe replacements made by tests. */
export interface TapTargetResolverHost {
  readonly accessibilityService: () => TapOnCtrlProxy;
  readonly adb: () => AdbExecutor;
  buildSelectedElementMetadata: TapTargetResolver["buildSelectedElementMetadata"];
  deriveInteractionEffect: typeof deriveInteractionEffect;
  readonly device: () => BootedDevice;
  readonly displayTransitionReader: () => DisplayTransitionReader;
  readonly elementParser: () => ElementParser;
  readonly ensureChecked: () => TapEnsureCheckedPhase;
  findElementInHierarchy: TapTargetResolver["findElementInHierarchy"];
  readonly finder: () => TapElementFinder;
  readonly focusVerifier: () => FocusVerifier;
  readonly geometry: () => ElementGeometry;
  getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"];
  getSearchUntilDuration: TapTargetResolver["getSearchUntilDuration"];
  hashViewHierarchy: TapTargetResolver["hashViewHierarchy"];
  readonly hierarchyCapture: () => HierarchyCapture;
  invisibleMatchFailure: TapTargetResolver["invisibleMatchFailure"];
  isClickableElement: TapTargetResolver["isClickableElement"];
  isElementTapTargetOffScreen: TapPointPlanner["isElementTapTargetOffScreen"];
  isLongClickableElement: TapTargetResolver["isLongClickableElement"];
  readonly postTapEffect: () => TapPostTapEffectPhase;
  refreshViewHierarchy: TapTargetResolver["refreshViewHierarchy"];
  readonly refreshedDisplayTransitions: () => Pick<
    DisplayTransitionTracker,
    "checkIdentity" | "record"
  >;
  readonly renderedDisplayGeneration: () => RenderedDisplayRevisionReader;
  replaceObservationHierarchy: TapTargetResolver["replaceObservationHierarchy"];
  resolveTapTargetElement: TapTargetResolver["resolveTapTargetElement"];
  readonly screenshotCapturer: () => ScreenshotCapturer;
  readonly selectionStateTracker: () => Pick<SelectionStateTracker, "prepare" | "finalize">;
  staleDisplay: (observedGeneration: number) => StaleDisplayError;
  staleSyntheticTarget: TapTargetResolver["staleSyntheticTarget"];
  readonly strategy: () => TapStrategy;
  readonly tapPoints: () => TapPointPlanner;
  tapVerificationRefresh: TapTargetResolver["tapVerificationRefresh"];
  readonly timer: () => Timer;
  readonly viewHierarchy: () => ViewHierarchy;
  readonly visionAnalyzer: () => VisionAnalyzer | undefined;
  readonly visionConfig: () => VisionFallbackConfig;
  withObservationScreenSize: TapTargetResolver["withObservationScreenSize"];
}

/** Resolves targets from fresh hierarchies and verifies focus and checked state. */
export class TapTargetResolver {
  constructor(private readonly host: TapTargetResolverHost) {}

  getSearchUntilDuration(options: TapOnElementOptions): number {
    return resolveSearchUntilDuration(options.searchUntil?.duration, {
      defaultMs: SEARCH_UNTIL_DEFAULT_MS,
      minMs: SEARCH_UNTIL_MIN_MS,
      maxMs: SEARCH_UNTIL_MAX_MS,
    });
  }

  hashViewHierarchy(viewHierarchy: ViewHierarchyResult | null): string | null {
    return hierarchyFingerprint(viewHierarchy);
  }

  deriveTapEffect(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult | undefined,
  ): TapOnElementResult["effect"] | undefined {
    return this.host.deriveInteractionEffect(previousObservation, currentObservation);
  }

  async deriveTapEffectAfterPostTapObservation(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
    call?: Pick<TapOnCall, "settlePostTapEffect">,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    return this.host
      .postTapEffect()
      .deriveEffectAfterPostTapObservation(previousObservation, currentObservation, signal, call);
  }

  enforceFreshnessConsistencyWithEffect(
    previousObservation: ObserveResult | null,
    result: { effect?: TapOnElementResult["effect"]; observation?: ObserveResult },
  ): void {
    this.host.postTapEffect().enforceFreshnessConsistency(previousObservation, result);
  }

  replaceObservationHierarchy(
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ): void {
    this.host
      .postTapEffect()
      .replaceObservationHierarchy(observeResult, viewHierarchy, refreshedFromDevice);
  }

  logClickableParentSelection(usedParent: boolean): void {
    if (usedParent) {
      logger.info("[TapOnElement] Using clickable parent for non-clickable element");
    }
  }

  async prepareSelectionCapture(
    action: string,
    observation: ObserveResult,
    element: Element,
    signal?: AbortSignal,
  ): Promise<SelectionCaptureState | null> {
    return this.host.selectionStateTracker().prepare({
      action,
      observation,
      element,
      signal,
    });
  }

  withObservationScreenSize(
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ): TapVerificationOptions {
    return {
      ...options,
      screenSizeOptions: {
        observationScreenSize: observation.screenSize,
        display: observation.viewHierarchy,
      },
    };
  }

  findElementInHierarchy(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);
    try {
      return this.host.finder().selectElementInHierarchy(options, viewHierarchy);
    } catch (error) {
      if (
        options.action !== "focus" ||
        !(error instanceof ActionableError) ||
        error instanceof TapTargetUnavailableError ||
        (!isStrictlyScoped(options) && options.index === undefined) ||
        !this.host.finder().isContainerAvailable(viewHierarchy, options.container)
      ) {
        throw error;
      }
      return this.host.finder().classifyFocusSelectionFailure(options, viewHierarchy, error);
    }
  }

  verifyFocusedInputTarget(
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    hints: FocusVerificationHints = {},
  ): boolean {
    return this.host.focusVerifier().verify(options, target, observation, hints);
  }

  invisibleMatchFailure(
    ...args: Parameters<TapPointPlanner["invisibleMatchFailure"]>
  ): ReturnType<TapPointPlanner["invisibleMatchFailure"]> {
    return this.host.tapPoints().invisibleMatchFailure(...args);
  }

  resolveTapPoint(
    ...args: Parameters<TapPointPlanner["resolveTapPoint"]>
  ): ReturnType<TapPointPlanner["resolveTapPoint"]> {
    return this.host.tapPoints().resolveTapPoint(...args);
  }

  resolveContainerElement(
    ...args: Parameters<TapElementFinder["resolveContainerElement"]>
  ): ReturnType<TapElementFinder["resolveContainerElement"]> {
    return this.host.finder().resolveContainerElement(...args);
  }

  visibleTapBounds(
    ...args: Parameters<TapPointPlanner["visibleTapBounds"]>
  ): ReturnType<TapPointPlanner["visibleTapBounds"]> {
    return this.host.tapPoints().visibleTapBounds(...args);
  }

  resolveVisibleTapPoint(
    ...args: Parameters<TapPointPlanner["resolveVisibleTapPoint"]>
  ): ReturnType<TapPointPlanner["resolveVisibleTapPoint"]> {
    return this.host.tapPoints().resolveVisibleTapPoint(...args);
  }

  async verifyFocusAfterTap(
    result: TapOnElementResult,
    verify: (observation: ObserveResult | undefined) => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (verify(result.observation)) {
      return true;
    }
    const initial = result.observation;
    if (!this.host.strategy().settlesFocusChangeAfterTap || !initial) {
      return false;
    }
    const deadline = this.host.timer().now() + IOS_FOCUS_SETTLE_TIMEOUT_MS;
    while (this.host.timer().now() < deadline) {
      await this.host.timer().sleep(POST_TAP_EFFECT_POLL_MS);
      throwIfAborted(signal);
      const hierarchy = await this.host.refreshViewHierarchy(
        deadline - this.host.timer().now(),
        initial.screenSize,
        signal,
        true,
      );
      if (!hierarchy) {
        continue;
      }
      const observation: ObserveResult = { ...initial };
      this.host.replaceObservationHierarchy(observation, hierarchy, true);
      if (verify(observation)) {
        result.observation = observation;
        return true;
      }
    }
    return false;
  }

  private prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult {
    if (returnsRawHierarchyUnfiltered(serverConfig.isRawElementSearchEnabled(), rawHierarchy)) {
      return rawHierarchy;
    }

    const filtered = this.host
      .strategy()
      .prepareViewHierarchyForResponse(rawHierarchy, this.host.viewHierarchy(), screenSize);
    return filtered ?? rawHierarchy;
  }

  async refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    if (timeoutMs <= 0) {
      return null;
    }
    const observedGeneration =
      this.host.renderedDisplayGeneration()(this.host.device().deviceId) ??
      this.host.displayTransitionReader().identityRevision(this.host.device().deviceId);
    let captured: ViewHierarchyResult;
    try {
      captured = (
        await this.host.hierarchyCapture().capture({
          freshness: "fresh",
          ...(forceCapture ? { requireFreshExtraction: true } : {}),
          searchRaw: serverConfig.isRawElementSearchEnabled(),
          timeoutMs,
          signal,
        })
      ).hierarchy;
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(`[TapOnElement] Fresh capture failed: ${errorMessage(error)}`);
      return null;
    }
    if (isUsableScreenSize(screenSize) && this.host.strategy().verifiesRefreshedDisplay) {
      await this.checkRefreshedDisplay(captured, screenSize, observedGeneration, signal);
    }
    return captured;
  }

  tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"] {
    return (
      context.refresh ??
      ((timeoutMs) => this.host.refreshViewHierarchy(timeoutMs, context.screenSize, context.signal))
    );
  }

  private async checkRefreshedDisplay(
    captured: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"],
    observedGeneration: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const freshSize = this.host.getScreenSizeFromHierarchy(captured);
    if (
      !freshSize ||
      (freshSize.width === screenSize.width &&
        freshSize.height === screenSize.height &&
        (this.host.device().displays?.panels.length ?? 0) < 2)
    ) {
      return;
    }
    const display = await this.refreshedDisplay(captured, signal);
    const identityChanged = this.host
      .refreshedDisplayTransitions()
      .checkIdentity(this.host.device().deviceId, display);
    const geometryTransition = this.host
      .refreshedDisplayTransitions()
      .record(this.host.device().deviceId, {
        display,
        screenSize: freshSize,
      });
    if (identityChanged || geometryTransition) {
      throw this.host.staleDisplay(observedGeneration);
    }
  }

  private async refreshedDisplay(
    captured: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<ObserveResult["display"]> {
    const displayCache = new ObservedAndroidDisplayCache(this.host.timer());
    const focusedPanel = await displayCache.panelForLogicalId(
      this.host.device(),
      this.host.adb(),
      captured.displayId,
      {
        signal,
        identity: {
          panelUniqueId: captured.panelUniqueId,
          panelFingerprint: captured.panelFingerprint,
        },
        allowProbe: false,
      },
    );
    const resolved = await displayCache.resolve(this.host.device(), this.host.adb(), signal);
    const panel =
      focusedPanel ??
      this.host
        .device()
        .displays?.panels.find((candidate) => candidate.key === resolved.display.key);
    return {
      ...resolved.display,
      key: panel?.key ?? resolved.display.key,
      role: panel?.role ?? resolved.display.role,
      posture: await displayCache.posture(this.host.device(), this.host.adb(), signal),
    };
  }

  async readFreshHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    if (effectiveTimeoutMs === 0) {
      return null;
    }
    return readFreshPlatformHierarchy(
      {
        device: this.host.device(),
        adb: this.host.adb(),
        timer: this.host.timer(),
        androidService: this.host.accessibilityService(),
        viewHierarchy: this.host.viewHierarchy(),
        prepareForResponse: (raw, size) => this.prepareViewHierarchyForResponse(raw, size),
        actionLabel: "tap on elements",
      },
      { timeoutMs: effectiveTimeoutMs, screenSize, signal, forceCapture },
    );
  }

  resolveAndroidStableTapTargetAfterRefreshes(
    options: TapVerificationOptions,
    observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal,
  ): Promise<StableTapTargetResult> {
    return resolveAndroidStableTapTarget(
      {
        timer: this.host.timer(),
        elementParser: this.host.elementParser(),
        findElementInHierarchy: (opts, hierarchy) =>
          this.host.findElementInHierarchy(opts, hierarchy),
        resolveTapTargetElement: (element, hierarchy, tapAction, tapOptions) =>
          this.host.resolveTapTargetElement(element, hierarchy, tapAction, tapOptions),
        staleSyntheticTarget: (original, previous, current) =>
          this.host.staleSyntheticTarget(original, previous, current),
        tapVerificationRefresh: (context) => this.host.tapVerificationRefresh(context),
        withObservationScreenSize: (opts, observation) =>
          this.host.withObservationScreenSize(opts, observation),
      },
      { options, observeResult, action, requireResourceId, signal },
    );
  }

  staleSyntheticTarget(
    original: Element | null,
    previous: ViewHierarchyResult | undefined,
    current: ViewHierarchyResult,
  ): string | undefined {
    if (!original || original["resource-id"] || !original["view-id"] || !previous) {
      return undefined;
    }
    const projection = new SearchableHierarchy();
    const nodeKey = original["view-id"];
    const oldNode = projection.project(previous).find((node) => node.nodeKey === nodeKey);
    if (!oldNode) {
      return "Stale tap target: the observed reference is no longer identifiable.";
    }
    const oldId = getHierarchySnapshot(previous)?.captureId ?? "before-refresh";
    const newId =
      getHierarchySnapshot(current)?.captureId ?? (previous === current ? oldId : "after-refresh");
    const result = new ElementResolver().resolve(
      { id: newId, nodes: projection.project(current) },
      { elementId: nodeKey },
      {
        action: "inspect",
        ref: {
          snapshotId: oldId,
          nodeKey,
          bounds: oldNode.bounds,
          label: oldNode.label,
          nativeId: oldNode.nativeId,
        },
      },
    );
    return result.error;
  }

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

  private findElementForSearch(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): ReturnType<TapOnElement["findElementInHierarchy"]> {
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
    const startTime = this.host.timer().now();
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
        timer: this.host.timer(),
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
          if (hash && hash !== lastHash) {
            changeCount += 1;
            lastHash = hash;
          } else if (hash && !lastHash) {
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

    this.reportOffScreenRejections(offScreenRejections, element);

    const stats: SearchUntilStats = {
      durationMs: Math.max(0, Math.round(this.host.timer().now() - startTime)),
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

  private reportOffScreenRejections(offScreenRejections: number, element: Element | null): void {
    if (offScreenRejections > 0 && !element) {
      logger.warn(
        `[TapOnElement] Element was found ${offScreenRejections} time(s) but had no visible tap area. ` +
          "Scroll it into view before retrying.",
      );
    }
  }

  buildSelectedElementMetadata(
    selection: ElementSelectionResult,
  ): TapOnSelectedElement | undefined {
    if (!selection.element) {
      return undefined;
    }

    const bounds = selection.element.bounds;
    const center = this.host.geometry().getElementCenter(selection.element);
    const text =
      getToggleContentDescription(selection.element) ??
      (typeof selection.element.text === "string" && selection.element.text.length > 0
        ? selection.element.text
        : typeof selection.element["content-desc"] === "string"
          ? selection.element["content-desc"]
          : typeof selection.element["ios-accessibility-label"] === "string"
            ? selection.element["ios-accessibility-label"]
            : "");
    const resourceId =
      typeof selection.element["resource-id"] === "string" ? selection.element["resource-id"] : "";
    const testTag =
      typeof selection.element["test-tag"] === "string" ? selection.element["test-tag"] : undefined;

    return {
      ...(selection.matchedElement ? { matchedElement: selection.matchedElement } : {}),
      ...(selection.captureId ? { captureId: selection.captureId } : {}),
      text,
      resourceId,
      ...(testTag ? { testTag } : {}),
      bounds: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        centerX: center.x,
        centerY: center.y,
      },
      indexInMatches: selection.indexInMatches,
      totalMatches: selection.totalMatches,
      selectionStrategy: selection.strategy,
    };
  }

  rebuildSelectedElementMetadataAfterStability(
    previous: TapOnSelectedElement | undefined,
    selection: ElementSelectionResult,
  ): TapOnSelectedElement | undefined {
    return this.host.buildSelectedElementMetadata(selection) ?? previous;
  }

  async handleElementNotFound(
    options: TapOnElementOptions,
    observeResult?: ObserveResult,
    containerFound: boolean = true,
    signal?: AbortSignal,
    selection?: ElementSelectionResult,
  ): Promise<never> {
    this.assertContainerFound(options, containerFound);
    const containerHint = this.containerHint(options);
    const baseError = this.elementNotFoundMessage(options, containerHint);

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
        { signal, visionAnalyzer: this.host.visionAnalyzer() },
      );
      throw new TapTargetUnavailableError(enrichedMsg, "not-found");
    }

    throw new TapTargetUnavailableError(baseError, "not-found");
  }

  private assertContainerFound(options: TapOnElementOptions, containerFound: boolean): void {
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
  }

  private containerHint(options: TapOnElementOptions): string {
    return options.container
      ? ` within container ${options.container.elementId ? `elementId '${options.container.elementId}'` : `text '${options.container.text}'`}`
      : "";
  }

  private siblingNotFoundMessage(
    options: TapOnElementOptions,
    containerHint: string,
  ): string | undefined {
    if (options.sibling && options.text) {
      return `No clickable sibling found next to element with text '${options.text}'${containerHint}`;
    } else if (options.sibling && options.elementId) {
      return `No clickable sibling found next to element with elementId '${options.elementId}'${containerHint}`;
    }
    return undefined;
  }

  private elementNotFoundMessage(options: TapOnElementOptions, containerHint: string): string {
    const siblingError = this.siblingNotFoundMessage(options, containerHint);
    if (siblingError !== undefined) {
      return siblingError;
    }
    if (options.text) {
      return `Element not found with provided text '${options.text}'${containerHint}`;
    } else if (options.textAny) {
      return `Element not found with any provided text '${options.textAny.join("', '")}'${containerHint}`;
    } else if (options.testTag) {
      return `Element not found with provided testTag '${options.testTag}'${containerHint}`;
    } else if (options.accessibilityLink) {
      return `Element not found with provided accessibilityLink '${options.accessibilityLink}'${containerHint}`;
    } else {
      return options.elementId?.startsWith("s2-")
        ? `Element id '${options.elementId}' is stale; re-observe and use the id from the new observation.${containerHint}`
        : `Element not found with provided elementId '${options.elementId}'${containerHint}`;
    }
  }

  isClickableElement(element: Element): boolean {
    return isTruthyFlag(element.clickable) || hasAccessibilityAction(element.actions, "click");
  }

  isLongClickableElement(element: Element): boolean {
    return (
      isTruthyFlag(element["long-clickable"]) ||
      isTruthyFlag(element.longClickable) ||
      hasAccessibilityAction(element.actions, "long_click")
    );
  }

  elementAffordances(element: Element): string[] {
    const affordances: string[] = [];
    if (this.host.isClickableElement(element)) {
      affordances.push("tap");
    }
    if (this.host.isLongClickableElement(element)) {
      affordances.push("long-press");
    }
    const className = typeof element.class === "string" ? element.class : "";
    if (
      isTruthyFlag(element.focusable) &&
      (className.includes("EditText") ||
        (typeof element["input-type"] === "string" && element["input-type"].trim() !== ""))
    ) {
      affordances.push("input");
    }
    if (isTruthyFlag(element.scrollable)) {
      affordances.push("scroll");
    }
    if (isTruthyFlag(element.checkable)) {
      affordances.push("toggle");
    }
    return affordances;
  }

  elementIdentity(element: Element): string {
    return (
      element.text ??
      element["resource-id"] ??
      element["testTag"] ??
      element["test-tag"] ??
      element["content-desc"] ??
      "unidentified element"
    );
  }

  ensureCheckedBeforeTap(
    options: TapOnElementOptions,
    element: Element,
    selectedElement: TapOnSelectedElement | undefined,
    searchUntil: SearchUntilStats,
  ): TapOnElementResult | undefined {
    return this.host.ensureChecked().beforeTap(options, element, selectedElement, searchUntil);
  }

  refreshEnsureCheckedSelection(
    options: TapVerificationOptions,
    observation: ObserveResult,
    selection: ElementSelectionResult,
    signal?: AbortSignal,
  ): Promise<{ selection: ElementSelectionResult; viewHierarchy: ViewHierarchyResult }> {
    return this.host.ensureChecked().refreshSelection(options, observation, selection, signal);
  }

  applyEnsureCheckedResult(
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.host.ensureChecked().applyResult(result, options, signal);
  }

  resolveTapTargetElement(
    element: Element,
    viewHierarchy: ViewHierarchyResult | null,
    action: string,
    targetOptions: boolean | { requireResourceId: boolean; scoped: boolean },
  ): { element: Element; usedParent: boolean } {
    // Scoped lookups already select within the resolver boundary. Do not promote
    // their result to a container or an ancestor outside the requested subtree.
    if (typeof targetOptions !== "boolean" && targetOptions.scoped) {
      return { element, usedParent: false };
    }
    const requireResourceId =
      typeof targetOptions === "boolean" ? targetOptions : targetOptions.requireResourceId;
    if (!viewHierarchy || !this.host.strategy().promotesClickableAncestor) {
      return { element, usedParent: false };
    }
    const nodes = new SearchableHierarchy().project(viewHierarchy);
    const matched = findTapTargetNode(nodes, element);
    const target = matched
      ? promoteClickableAncestor(matched, nodes, {
          action: action === "longPress" ? "long-press" : "tap",
          requireResourceId,
        })
      : null;
    if (target?.element) {
      return {
        element: target.element,
        usedParent: !boundsEqual(target.element.bounds, element.bounds),
      };
    }
    return { element, usedParent: false };
  }
}
