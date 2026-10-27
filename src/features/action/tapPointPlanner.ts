import {
  TapTargetUnavailableError,
  findTapTargetNode,
  hasTapArea,
  pointInTapBounds,
  selectionHierarchyFor,
  tapOwnPrototypeCoverRule,
  type TapFocusFailure,
  type TapPointContext,
} from "./tapTargetSupport";
import { describeFocusTarget } from "./tapFocusIdentity";
import { matchedTapElement } from "./tapPointGeometry";
import { applicationWindowSafeTapPoint } from "../observe/HierarchyHitTest";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { SearchableHierarchy } from "../utility/SearchableNode";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementBounds,
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import {
  visibleTapBounds,
  screenSizeForOffscreenCheck,
  isUsableScreenSize,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import { intersectBounds as intersectTapBounds } from "../../utils/bounds";
import {
  isOwnPrototypeNode,
  resolvePrototypeTapUnderSystemBar,
  type PrototypeBarTapDecision,
} from "./prototypeTapUnderSystemBars";
import { assertAppGestureNotUnderPrototype } from "../observe/hierarchyLayer";
import {
  isPrototypeHostDismissId,
  resolveTapOffHostControls,
} from "../prototype/prototypeHostControls";
import type { TapBoundsClip, TapStrategy } from "../../utils/interfaces/TapStrategy";
import { DefaultObserveElementCollector } from "../observe/ObserveElementCollector";
import {
  getImeOccluderForElement,
  getIosImeOccluder,
  tapPointOutsideIme,
} from "../observe/output/SkeletonProjection";
import { isIosTapPointCoveredByChrome } from "./swipeon/iosChromeInsets";
import {
  createIosVisibleTapContext,
  iosVisibleTapArea,
  isIosTapFrameReduced,
  iosTapOwnershipErrorMessage,
  resolveIosOwnedTapPoint,
} from "./iosTapTargetOwnership";

/** What tap-point planning needs from the owning tap action (read lazily; tests swap them). */
export interface TapPointPlannerDeps {
  readonly device: BootedDevice;
  readonly geometry: () => ElementGeometry;
  readonly strategy: () => TapStrategy;
}

/**
 * Chooses where a resolved element is tapped: visible bounds, IME and navigation-bar
 * occlusion, prototype-bar handling. Never dispatches or reads the device.
 */
export class TapPointPlanner {
  constructor(private readonly deps: TapPointPlannerDeps) {}

  resolveTapPoint(element: Element): { x: number; y: number } {
    return this.deps.geometry().getElementCenter(element);
  }

  getImeOccluderForTap(
    element: Element,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ) {
    const platform = this.deps.device.platform;
    if (platform !== "android" && platform !== "ios") {
      return undefined;
    }
    const elements = new DefaultObserveElementCollector().collect(
      selectionHierarchyFor(element, hierarchy, platform),
      platform,
    );
    const ime = elements && getImeOccluderForElement(elements, element);
    return ime && platform === "ios" ? getIosImeOccluder(ime, screenSize) : ime;
  }

  /** Judge an Android tap on one of CtrlProxy's own prototype controls against the system bars (#10086). */
  prototypeBarTapDecision(
    hierarchy: ViewHierarchyResult,
    element: Element,
    point: { x: number; y: number },
  ): PrototypeBarTapDecision {
    if (this.deps.device.platform !== "android") {
      return { kind: "proceed", point };
    }
    const owner = findTapTargetNode(new SearchableHierarchy().project(hierarchy), element)?.source;
    return resolvePrototypeTapUnderSystemBar({
      hierarchy,
      ownedByPrototype: isOwnPrototypeNode(hierarchy, owner),
      bounds: element.bounds,
      point,
    });
  }

  resolveImeSafeTapPoint(
    element: Element,
    hierarchy: ViewHierarchyResult,
    { options, screenSize }: TapPointContext,
    bounds: ElementBounds = element.bounds,
  ): { x: number; y: number } {
    const ime = this.getImeOccluderForTap(element, hierarchy, screenSize);
    if (!ime) {
      return this.resolveTapPoint(element);
    }
    const { left, top, right, bottom } = bounds;
    const point = tapPointOutsideIme([left, top, right, bottom], ime.bounds);
    // Check the candidate before dispatch, even if the safe-point helper regresses.
    // HierarchyHitTest estimates accessible nodes, whose root bounds can extend
    // above the touch-owning frame; use the captured window rectangle here.
    const imeBounds = {
      left: ime.bounds[0],
      top: ime.bounds[1],
      right: ime.bounds[2],
      bottom: ime.bounds[3],
    };
    if (point && !pointInTapBounds(point, imeBounds)) {
      return point;
    }
    const elementLabel = element.text ?? element["content-desc"] ?? element["resource-id"];
    const focusTarget = describeFocusTarget(element, options);
    const selectorLabel =
      focusTarget !== "the matched element"
        ? focusTarget
        : JSON.stringify(
            options.elementId ?? options.testTag ?? options.accessibilityLink ?? "element",
          );
    const label = JSON.stringify(elementLabel) ?? selectorLabel;
    throw new KeyboardOcclusionError(
      `Target ${label} is covered by the soft keyboard; dismiss the keyboard first.`,
    );
  }

  isElementTapTargetOffScreen(
    selection: ElementSelectionResult,
    viewHierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    options?: TapOnElementOptions,
  ): boolean {
    if (!isUsableScreenSize(screenSize)) {
      return false;
    }
    return !this.visibleTapBounds(selection, viewHierarchy, screenSize, options);
  }

  invisibleMatchError(
    selection: ElementSelectionResult,
    options: TapOnElementOptions,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): string {
    const matched = selection.matchedElement ?? selection.element;
    if (this.isCoveredByNavigationBar(selection, hierarchy, screenSize)) {
      return `Target ${JSON.stringify(matched?.text ?? options.text ?? options.elementId ?? "target")} is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.`;
    }
    return (
      `Matched element ${JSON.stringify(matched?.text ?? options.text ?? options.elementId ?? "target")} ` +
      `has no visible tap area (bounds ${JSON.stringify(matched?.bounds)}). ` +
      "Scroll it into view with swipeOn, then retry tapOn."
    );
  }

  visibilityFailureReason(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): TapFocusFailure {
    return this.isCoveredByNavigationBar(selection, hierarchy, screenSize)
      ? "navigation-bar"
      : "no-visible-tap-area";
  }

  invisibleMatchFailure(
    selection: ElementSelectionResult,
    options: TapOnElementOptions,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    fallback?: string,
  ): TapTargetUnavailableError {
    const reason = this.visibilityFailureReason(selection, hierarchy, screenSize);
    return new TapTargetUnavailableError(
      reason === "navigation-bar" || !fallback
        ? this.invisibleMatchError(selection, options, hierarchy, screenSize)
        : fallback,
      reason,
    );
  }

  navigationTapBounds(
    bounds: ElementBounds,
    hierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    elements: readonly Element[],
  ): TapBoundsClip {
    return this.deps.strategy().clipNavigationTapBounds(bounds, hierarchy, screenSize, elements);
  }

  isCoveredByNavigationBar(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): boolean {
    const target = selection.element ?? selection.matchedElement;
    if (!target) {
      return false;
    }
    const matched = selection.matchedElement ?? target;
    const overlap = intersectTapBounds(target.bounds, matched.bounds);
    return (
      !!overlap &&
      !!this.navigationTapBounds(overlap, hierarchy, screenSize, [matched, target]).coveredBy
    );
  }

  visibleTapBounds(
    selection: ElementSelectionResult,
    hierarchy: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
    options?: TapOnElementOptions,
    tapTarget?: Element,
  ): ElementBounds | null {
    const target = tapTarget ?? selection.element;
    if (!target?.bounds) {
      return null;
    }
    const matched = matchedTapElement(selection, target, options);
    const matchedBounds = matched.bounds;
    const matchForTap = hasTapArea(matchedBounds) ? matched : target;
    const visible = visibleTapBounds(target.bounds, screenSize, matchForTap.bounds);
    if (!visible || !isUsableScreenSize(screenSize) || this.deps.device.platform !== "ios") {
      return visible;
    }
    const nodes = new SearchableHierarchy().project(hierarchy);
    return iosVisibleTapArea({
      bounds: visible,
      matched: matchForTap,
      target,
      nodes,
      context: createIosVisibleTapContext(nodes, screenSize, hierarchy),
    });
  }

  resolveVisibleTapPoint(
    target: Element,
    hierarchy: ViewHierarchyResult,
    visibleBounds: ElementBounds,
    context: TapPointContext,
  ): { x: number; y: number } | null {
    const point = this.resolveImeSafeTapPoint(target, hierarchy, context);
    const { left, top, right, bottom } = visibleBounds;
    const ime = this.getImeOccluderForTap(target, hierarchy, context.screenSize);
    if (this.deps.device.platform !== "ios") {
      const proposed = pointInTapBounds(point, visibleBounds)
        ? point
        : ime
          ? this.resolveImeSafeTapPoint(target, hierarchy, context, visibleBounds)
          : this.deps.geometry().getElementCenter({ bounds: visibleBounds });
      const safe = applicationWindowSafeTapPoint(
        hierarchy,
        target,
        visibleBounds,
        proposed,
        ime && {
          left: ime.bounds[0],
          top: ime.bounds[1],
          right: ime.bounds[2],
          bottom: ime.bounds[3],
        },
        // Default-layer selectors also resolve app rows kept under AutoMobile's own prototype
        // (#10691); layer "app" refuses those later with its own prototype-specific error.
        tapOwnPrototypeCoverRule(context.options.layer),
      );
      if (!safe.point) {
        throw new TapTargetUnavailableError(
          `Target is covered by ${safe.coveredBy}; dismiss the covering window, then retry tapOn.`,
          "no-visible-tap-area",
        );
      }
      return safe.point;
    }
    const exposedImePoint = ime ? tapPointOutsideIme([left, top, right, bottom], ime.bounds) : null;
    const exposedCenter = this.deps.geometry().getElementCenter({ bounds: visibleBounds });
    const chromeElements = context.chromeElements ?? [target];
    const navClipped = this.navigationTapBounds(
      target.bounds,
      hierarchy,
      context.screenSize,
      chromeElements,
    ).bounds;
    if (!navClipped) {
      return null;
    }
    const nodes = new SearchableHierarchy().project(hierarchy);
    const targetNode = findTapTargetNode(nodes, target);
    const candidates = isIosTapFrameReduced(nodes, targetNode, target.bounds, navClipped)
      ? [exposedImePoint, exposedCenter, point]
      : [point, exposedImePoint, exposedCenter];
    const imeBounds = ime && {
      left: ime.bounds[0],
      top: ime.bounds[1],
      right: ime.bounds[2],
      bottom: ime.bounds[3],
    };
    const safe = resolveIosOwnedTapPoint({
      nodes,
      target: targetNode,
      matched: chromeElements.flatMap((element) => {
        const node = findTapTargetNode(nodes, element);
        return node ? [node] : [];
      }),
      screen: context.screenSize,
      visibleBounds,
      candidates,
      imeBounds,
      isValid: (candidate): candidate is { x: number; y: number } =>
        candidate !== null &&
        Number.isInteger(candidate.x) &&
        Number.isInteger(candidate.y) &&
        pointInTapBounds(candidate, visibleBounds) &&
        pointInTapBounds(candidate, target.bounds) &&
        (!imeBounds || !pointInTapBounds(candidate, imeBounds)) &&
        (!isUsableScreenSize(context.screenSize) ||
          !isIosTapPointCoveredByChrome({
            point: candidate,
            hierarchy,
            screen: context.screenSize,
            elements: chromeElements,
          })),
    });
    if (safe.coveredBy) {
      throw new TapTargetUnavailableError(
        iosTapOwnershipErrorMessage(target, safe.coveredBy, safe.ownerInsideScrollContainer),
        "no-visible-tap-area",
      );
    }
    return safe.point;
  }

  getScreenSizeFromHierarchy(
    viewHierarchy: ViewHierarchyResult,
    options: ScreenSizeForOffscreenCheckOptions = {},
  ): ObserveResult["screenSize"] | undefined {
    return screenSizeForOffscreenCheck(viewHierarchy, {
      ...options,
      platform: this.deps.device.platform,
      iosMultiPanel:
        this.deps.device.platform === "ios" && (this.deps.device.displays?.panels.length ?? 0) > 1,
    });
  }

  private hostControls(hierarchy: ViewHierarchyResult): { id: string; bounds: ElementBounds }[] {
    return new SearchableHierarchy()
      .project(hierarchy)
      .flatMap((entry) =>
        isPrototypeHostDismissId(entry.nativeId) && entry.bounds
          ? [{ id: entry.nativeId as string, bounds: entry.bounds }]
          : [],
      );
  }

  /**
   * A tap point outside AutoMobile's host dismiss controls (#15120): a control drawn over the target
   * would take the touch and dismiss the prototype, so the point moves to the target's largest part
   * outside every control, or the tap is refused by naming the control.
   */
  private pointClearOfHostControls(
    hierarchy: ViewHierarchyResult,
    target: Element,
    visibleBounds: ElementBounds,
    point: { x: number; y: number },
  ): { x: number; y: number } {
    const controls = this.hostControls(hierarchy);
    if (controls.length === 0) {
      return point;
    }
    const decision = resolveTapOffHostControls({
      controls,
      targetId: target["resource-id"],
      visibleBounds,
      point,
    });
    if (decision.kind === "refuse") {
      throw new ActionableError(
        `Cannot tap (${point.x}, ${point.y}): the AutoMobile prototype control ${decision.control} covers the whole visible target and a touch there would dismiss the prototype. ` +
          "Move the target away from the top-end corner (or the top-centre escape pill), then retry.",
      );
    }
    return decision.point;
  }

  /** Pick the tap point inside the visible, unobstructed part of the resolved element. */
  planVisibleTapPoint({
    options,
    requestedAction,
    observeResult,
    viewHierarchy,
    finalSelection,
    tapElement,
  }: {
    options: TapOnElementOptions;
    requestedAction: NonNullable<TapOnElementOptions["action"]>;
    observeResult: ObserveResult;
    viewHierarchy: ViewHierarchyResult;
    finalSelection: ElementSelectionResult;
    tapElement: Element;
  }): { tapPoint: { x: number; y: number }; warning?: string } {
    const screenSize = this.getScreenSizeFromHierarchy(viewHierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    const visibleBounds = this.visibleTapBounds(
      finalSelection,
      viewHierarchy,
      screenSize,
      requestedAction === "focus" ? { ...options, action: "focus" } : options,
      tapElement,
    );
    if (!visibleBounds) {
      throw this.invisibleMatchFailure(
        finalSelection,
        options,
        viewHierarchy,
        screenSize,
        "Matched element has no visible tap area on this screen. " +
          "Scroll it into view with swipeOn, then retry tapOn.",
      );
    }
    const visibleTapPoint = this.resolveVisibleTapPoint(tapElement, viewHierarchy, visibleBounds, {
      options,
      screenSize,
      chromeElements: [
        matchedTapElement(
          finalSelection,
          tapElement,
          requestedAction === "focus" ? { ...options, action: "focus" } : options,
        ),
        tapElement,
      ],
    });
    if (!visibleTapPoint) {
      throw this.invisibleMatchFailure(
        finalSelection,
        options,
        viewHierarchy,
        screenSize,
        "Matched element has no unobstructed visible tap area. " +
          "Dismiss the keyboard or scroll it into view, then retry tapOn.",
      );
    }
    const clearPoint = this.pointClearOfHostControls(
      viewHierarchy,
      tapElement,
      visibleBounds,
      visibleTapPoint,
    );
    // Moving the point off a host control must not move it back under the keyboard.
    const ime = this.getImeOccluderForTap(tapElement, viewHierarchy, screenSize);
    if (
      ime &&
      clearPoint !== visibleTapPoint &&
      pointInTapBounds(clearPoint, {
        left: ime.bounds[0],
        top: ime.bounds[1],
        right: ime.bounds[2],
        bottom: ime.bounds[3],
      })
    ) {
      throw new KeyboardOcclusionError(
        "Target is covered by the soft keyboard and a host dismiss control; dismiss the keyboard first.",
      );
    }
    const barDecision = this.prototypeBarTapDecision(viewHierarchy, tapElement, clearPoint);
    if (barDecision.kind === "refuse") {
      throw new ActionableError(
        `Cannot tap (${clearPoint.x}, ${clearPoint.y}): the AutoMobile prototype control is under the ${barDecision.bar} and the touch would not reach it. ` +
          "Move the control inside the safe area (safeAreaPadding on the node, or an offset in the floating placement), then retry.",
      );
    }
    const tapPoint = barDecision.point;
    // The system-bar adjustment may move the point; it must not land back inside a host control.
    const covering = this.hostControls(viewHierarchy).find(
      (control) =>
        !isPrototypeHostDismissId(tapElement["resource-id"]) &&
        pointInTapBounds(tapPoint, control.bounds),
    );
    if (covering) {
      throw new ActionableError(
        `Cannot tap (${tapPoint.x}, ${tapPoint.y}): the AutoMobile prototype control ${covering.id} covers the visible target once the system bars are avoided and a touch there would dismiss the prototype. ` +
          "Move the target away from the top-end corner (or the top-centre escape pill), then retry.",
      );
    }
    // The selector resolved in the scoped tree; the touch lands on whatever is on top (#9305).
    assertAppGestureNotUnderPrototype(viewHierarchy, options.layer, tapPoint, "tap");
    return { tapPoint, ...(barDecision.warning ? { warning: barDecision.warning } : {}) };
  }
}
