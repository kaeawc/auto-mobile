import type { TapVerificationOptions } from "./tapVerificationOptions";
import {
  ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
  distinctFocusFields,
  findFocusIdentifier,
  focusFieldSizeMatches,
  focusScrollDelta,
  hasStableFocusIdentity,
  isSameFocusTarget,
  type FocusIdentifierKey,
} from "./tapFocusIdentity";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  BootedDevice,
  Element,
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { logger } from "../../utils/logger";
import { boundsArea, boundsNearlyEqual, horizontalExtentNearlyEqual } from "../../utils/bounds";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { compareSelectionRank } from "../utility/selectionRank";

/**
 * Identifiers of a node's ancestors, outermost first (e.g. `["cart_A", "item_42"]`).
 * A container captured twice under one identifier (iOS XCUITest + SDK nodes, #10266)
 * counts once.
 */
function identifiedAncestorChain(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
): string[] {
  const chain: string[] = [];
  for (let parent = node.parentIndex; parent !== undefined; parent = nodes[parent].parentIndex) {
    const properties = nodes[parent].properties;
    const id = properties["resource-id"] || properties["test-tag"];
    if (id && chain[0] !== id) {
      chain.unshift(id);
    }
  }
  return chain;
}

function sameChain(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** WebKit page focus does not identify a native browser input's keyboard focus. */
function isInsideWebView(node: SearchableEntry, nodes: readonly SearchableEntry[]): boolean {
  for (let parent = node.parentIndex; parent !== undefined; parent = nodes[parent].parentIndex) {
    if (nodes[parent].className === "WKWebView") {
      return true;
    }
  }
  return false;
}

/** Expansion must enclose the compact target and exceed capture jitter in at least one axis. */
function isExpandedFocusFrame(target: Element, candidate: Element): boolean {
  const epsilon = ANDROID_PRE_TAP_BOUNDS_EPSILON_PX;
  const before = target.bounds;
  const after = candidate.bounds;
  return (
    after.left <= before.left + epsilon &&
    after.top <= before.top + epsilon &&
    after.right >= before.right - epsilon &&
    after.bottom >= before.bottom - epsilon &&
    (after.right - after.left > before.right - before.left + epsilon ||
      after.bottom - after.top > before.bottom - before.top + epsilon)
  );
}

/** A settled keyboard permits a wider relocated editor or the same stable native field. */
function isKeyboardNativeEditor(
  target: Element,
  candidate: Element,
  nodes: readonly SearchableEntry[],
  screenHeight: number | undefined,
): boolean {
  const epsilon = ANDROID_PRE_TAP_BOUNDS_EPSILON_PX;
  const keyboardBelowEditor =
    screenHeight !== undefined &&
    nodes.some(
      (node) =>
        node.className === "UIKeyboard" &&
        node.bounds !== undefined &&
        node.bounds.top < screenHeight &&
        candidate.bounds.bottom <= node.bounds.top + epsilon,
    );
  const sameNativeId = (["resource-id", "view-id"] as const).some((key) => {
    const id = target[key];
    return id && !(key === "view-id" && id.startsWith("s2-")) && id === candidate[key];
  });
  return (
    keyboardBelowEditor &&
    (candidate.bounds.right - candidate.bounds.left >
      target.bounds.right - target.bounds.left + epsilon ||
      (sameNativeId && boundsNearlyEqual(target.bounds, candidate.bounds, epsilon)))
  );
}

/**
 * Safari replaces its compact URL field with an expanded native editor without a focused flag.
 * A sole native field of that class, expansion (or a keyboard-backed stable identity)
 * and non-conflicting labels identify the editor;
 * another native field holding keyboard focus rules it out.
 */
function findSoleExpandedNativeFocusField(
  target: Element,
  nodes: readonly SearchableEntry[],
  screenHeight: number | undefined,
  labelText?: string,
): Element | undefined {
  const nativeFields = distinctFocusFields(
    nodes.filter(
      (node) =>
        node.element && isFocusEditableElement(node.properties) && !isInsideWebView(node, nodes),
    ),
  );
  const candidates = nativeFields.filter((node) => node.className === target.class);
  if (candidates.length !== 1) {
    return undefined;
  }
  const candidate = candidates[0].element!;
  if (
    (!isExpandedFocusFrame(target, candidate) &&
      !isKeyboardNativeEditor(target, candidate, nodes, screenHeight)) ||
    nativeFields.some(
      (node) => node.element !== candidate && isElementKeyboardFocused(node.element!),
    )
  ) {
    return undefined;
  }
  const targetLabel = labelText ?? target.text;
  return typeof targetLabel === "string" &&
    targetLabel.length > 0 &&
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    targetLabel !== candidate.text
    ? undefined
    : candidate;
}

/** What the focus verifier needs from the owning tap action (kept narrow on purpose). */
export interface FocusVerifierDeps {
  device: BootedDevice;
  findElementInHierarchy: (
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ) => { selection: ElementSelectionResult; containerFound: boolean };
  withObservationScreenSize: (
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ) => TapVerificationOptions;
}

/**
 * Confirms that a post-tap capture shows the intended input focused. Pure over its inputs apart
 * from per-capture projection caches; it never dispatches or refreshes.
 */
export class FocusVerifier {
  constructor(private readonly deps: FocusVerifierDeps) {}

  private readonly preTapProjections = new WeakMap<
    ViewHierarchyResult,
    readonly SearchableEntry[]
  >();

  private findSoleFocusedFieldByStableIdentity(
    target: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
    preTapHierarchy?: ViewHierarchyResult,
  ): Element | undefined {
    const focusedFields = nodes.filter(
      (node) =>
        node.element &&
        isFocusEditableElement(node.properties) &&
        isElementKeyboardFocused(node.element),
    );
    const distinctFocusedFields = distinctFocusFields(focusedFields);
    if (distinctFocusedFields.length !== 1) {
      return undefined;
    }
    const candidate = distinctFocusedFields[0].element;
    return candidate &&
      (this.deps.device.platform === "android" && !candidate.text
        ? this.hasEmptyTextFocusIdentity(target, candidate, nodes, labelText, preTapHierarchy)
        : hasStableFocusIdentity(target, candidate, labelText)) &&
      horizontalExtentNearlyEqual(
        target.bounds,
        candidate.bounds,
        ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      )
      ? candidate
      : undefined;
  }

  /**
   * iOS re-labels a text field once it is focused: a field holding text exposes its
   * value rather than the label it was resolved by while unfocused (#13539). The
   * sole focused field at the target's pre-tap bounds, with no conflicting identity,
   * is the target.
   */
  private findSoleFocusedFieldAtTargetBounds(
    target: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
  ): Element | undefined {
    if (this.deps.device.platform !== "ios") {
      return undefined;
    }
    const focusedFields = distinctFocusFields(
      nodes.filter(
        (node) =>
          node.element &&
          isFocusEditableElement(node.properties) &&
          isElementKeyboardFocused(node.element),
      ),
    );
    const candidate = focusedFields.length === 1 ? focusedFields[0].element : undefined;
    return candidate &&
      boundsNearlyEqual(target.bounds, candidate.bounds, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX) &&
      !this.focusIdentitySignals(target, candidate, labelText).conflict
      ? candidate
      : undefined;
  }

  /** Shared so each captured hierarchy is projected once across the focus-confirmation reads. */
  private readonly focusProjection = new SearchableHierarchy();

  /** Labels depend only on the (immutable) captured node, so each node is projected once. */
  private readonly attachedFocusLabels = new WeakMap<object, string | undefined>();

  private attachedFocusLabel(element: Element): string | undefined {
    const source = getHierarchyNodeSource(element);
    if (!source) {
      return undefined;
    }
    if (this.attachedFocusLabels.has(source)) {
      return this.attachedFocusLabels.get(source);
    }
    const labels = this.focusProjection
      .project({ hierarchy: { node: source } })
      .filter((node) => node.parentIndex === 0 && !isFocusEditableElement(node.properties))
      .map((node) => node.textSources.text)
      .filter((text) => typeof text === "string" && text.trim().length > 0);
    const label = labels.length ? labels.join("\n") : undefined;
    this.attachedFocusLabels.set(source, label);
    return label;
  }

  private focusIdentitySignals(target: Element, candidate: Element, labelText?: string) {
    if (
      !isFocusEditableElement(target) ||
      target.class !== candidate.class ||
      !focusFieldSizeMatches(target, candidate) ||
      (["resource-id", "test-tag", "view-id"] as const).some(
        (key) =>
          [target[key], candidate[key]].some(
            (value) => value && !(key === "view-id" && value.startsWith("s2-")),
          ) && target[key] !== candidate[key],
      )
    ) {
      return { conflict: true, matched: false };
    }
    const pairs = [
      ...(["hint-text", "hint", "placeholder", "content-desc", "test-tag"] as const).map((key) => [
        target[key],
        candidate[key],
      ]),
      [
        this.attachedFocusLabel(target) ?? labelText ?? target.text,
        this.attachedFocusLabel(candidate),
      ],
    ].filter((pair) => pair.every((value) => typeof value === "string" && value.trim().length > 0));
    return {
      conflict: pairs.some(([before, after]) => before !== after),
      matched: pairs.some(([before, after]) => before === after),
    };
  }

  private hasEmptyTextFocusIdentity(
    target: Element,
    candidate: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    // Empty Compose fields can lose labels/s2 IDs on focus. Require matching size and
    // no label/hint or ordinal conflict, plus a label match, sole empty field at
    // adjusted bounds, or matching ordinal with a uniform pre/post scroll (including 0).
    const signals = this.focusIdentitySignals(target, candidate, labelText);
    if (signals.conflict) {
      return false;
    }
    const fields = distinctFocusFields(
      nodes.filter((node) => node.element && isFocusEditableElement(node.properties)),
    );
    const sameBoundsFields = fields.filter((node) =>
      boundsNearlyEqual(node.element!.bounds, candidate.bounds, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX),
    );
    if (sameBoundsFields.length !== 1) {
      return false;
    }
    const preNodes = preTapHierarchy
      ? this.focusProjection.project(resolveViewHierarchyForSearch(preTapHierarchy)!)
      : [];
    const preFields = distinctFocusFields(
      preNodes.filter((node) => node.element && isFocusEditableElement(node.properties)),
    );
    const targetFields = preFields.filter(
      (node) =>
        node.source === getHierarchyNodeSource(target) ||
        (node.className === target.class &&
          boundsNearlyEqual(
            node.element!.bounds,
            target.bounds,
            ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
          )),
    );
    const targetOrdinal = targetFields.length === 1 ? preFields.indexOf(targetFields[0]) : -1;
    const candidateOrdinal = fields.findIndex((node) => node.element === candidate);
    if (targetOrdinal >= 0 && targetOrdinal !== candidateOrdinal) {
      return false;
    }
    const delta = focusScrollDelta(preFields, fields);
    const scrollDelta = delta ?? 0;
    const adjustedBounds = {
      ...target.bounds,
      top: target.bounds.top + scrollDelta,
      bottom: target.bounds.bottom + scrollDelta,
    };
    const atTargetBounds = boundsNearlyEqual(
      adjustedBounds,
      candidate.bounds,
      ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
    );
    const emptyFields = fields.filter(
      (node) => node.className === target.class && !node.element!.text,
    );
    return (
      signals.matched ||
      (atTargetBounds && (emptyFields.length === 1 || (targetOrdinal >= 0 && delta !== undefined)))
    );
  }

  private verifyIndexedFocusTarget(
    options: TapOnElementOptions,
    target: Element,
    hierarchy: ViewHierarchyResult,
    identifier: { key: FocusIdentifierKey; value: string },
    selectedIndex?: number,
  ): boolean {
    const nodes = this.focusProjection.project(hierarchy);
    const selected = this.findIndexedFocusSelection(
      options,
      hierarchy,
      nodes,
      identifier,
      selectedIndex,
    );
    const selectedSource = selected && getHierarchyNodeSource(selected);
    const selectedNode = nodes.find((node) => node.source === selectedSource);
    return Boolean(
      selected &&
      isFocusEditableElement(selected) &&
      selectedNode &&
      nodes.some(
        (node) =>
          node.element &&
          isFocusEditableElement(node.properties) &&
          isElementKeyboardFocused(node.element) &&
          isSameFocusTarget(selected, node.element, nodes, selectedNode),
      ) &&
      selected[identifier.key] === identifier.value &&
      target.class === selected.class &&
      horizontalExtentNearlyEqual(
        target.bounds,
        selected.bounds,
        ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      ),
    );
  }

  private findIndexedFocusSelection(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
    nodes: readonly SearchableEntry[],
    identifier: { key: FocusIdentifierKey; value: string },
    selectedIndex?: number,
  ): Element | null {
    // A known focus target may carry a view-id shared by several id-less fields.
    // Public ID lookup rejects that ambiguous selector, so verify its selected
    // occurrence within the capture without re-entering the public lookup.
    const duplicateViewId =
      identifier.key === "view-id" &&
      options.elementId === identifier.value &&
      nodes.filter((node) => node.nodeKey === identifier.value && !node.nativeId).length > 1;
    const focusRank = (node: SearchableEntry) => ({
      windowRank: node.windowRank,
      area: node.bounds ? boundsArea(node.bounds) : Infinity,
      order: node.index,
      interactive: true,
    });
    if (duplicateViewId) {
      return (
        nodes
          .filter(
            (node) =>
              node.nodeKey === identifier.value &&
              !node.nativeId &&
              node.element &&
              isFocusEditableElement(node.properties),
          )
          .sort((a, b) => compareSelectionRank(focusRank(a), focusRank(b)))[
          options.index ?? selectedIndex ?? 0
        ]?.element ?? null
      );
    }
    return this.deps.findElementInHierarchy(
      {
        ...options,
        index:
          options.index ?? (options.selectionStrategy === "unique" ? undefined : selectedIndex),
      },
      hierarchy,
    ).selection.element;
  }

  private isFocusedMatchingNode(
    target: Element,
    node: SearchableEntry,
    nodes: readonly SearchableEntry[],
  ): boolean {
    return Boolean(
      node.element &&
      isFocusEditableElement(node.properties) &&
      isElementKeyboardFocused(node.element) &&
      isSameFocusTarget(target, node.element, nodes),
    );
  }

  private isRefoundFocusTarget(
    options: TapOnElementOptions,
    target: Element,
    hierarchy: ViewHierarchyResult,
  ): boolean {
    const candidate = this.deps.findElementInHierarchy(options, hierarchy).selection.element;
    return Boolean(
      candidate &&
      isFocusEditableElement(candidate) &&
      isElementKeyboardFocused(candidate) &&
      isSameFocusTarget(target, candidate, this.focusProjection.project(hierarchy)),
    );
  }

  /**
   * Whether the post-tap capture shows the target focused. A capture that cannot
   * re-resolve the selector scope (a container now ambiguous or missing, #10266) leaves
   * the focus unconfirmed so the caller can re-read; it never fails the tap itself.
   */
  verify(
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    labelText?: string,
    selectedIndex?: number,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    if (!observation?.viewHierarchy) {
      return false;
    }
    const searchHierarchy =
      resolveViewHierarchyForSearch(observation.viewHierarchy) ?? observation.viewHierarchy;
    const nodes = this.focusProjection.project(searchHierarchy);
    if (this.isFocusedInPreTapScope(target, nodes, labelText, preTapHierarchy)) {
      return true;
    }
    try {
      return this.matchFocusedInputTarget(
        options,
        this.deps.withObservationScreenSize(options, observation),
        target,
        observation.viewHierarchy,
        nodes,
        {
          labelText,
          selectedIndex,
          preTapHierarchy,
          screenHeight: observation.screenSize?.height ?? observation.viewHierarchy.screenHeight,
        },
      );
    } catch (error) {
      // The selector is re-resolved against a capture taken while the layout may still be
      // moving (keyboard avoidance, a lagging SDK snapshot); a scope it cannot resolve
      // there means "not confirmed yet", which the caller reports or re-reads.
      logger.debug(
        `[TapOnElement] focus check could not resolve the target: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Confirm focus by the identity the target had before the tap (#10266): the chain of
   * identified ancestors (e.g. `cart_A > item_42`) that singled the field out pre-tap.
   * The focused field must sit under the same chain and carry the target's identity.
   * This survives a layout shift after the tap and duplicate container nodes in the
   * post-tap capture, neither of which changes which field holds focus.
   */
  private isFocusedInPreTapScope(
    target: Element,
    nodes: readonly SearchableEntry[],
    labelText?: string,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean {
    const targetSource = getHierarchyNodeSource(target);
    if (!preTapHierarchy || !targetSource) {
      return false;
    }
    const preNodes = this.projectPreTapHierarchy(preTapHierarchy);
    const preTarget = preNodes.find((node) => node.source === targetSource);
    const scope = preTarget ? identifiedAncestorChain(preTarget, preNodes) : [];
    if (scope.length === 0) {
      return false;
    }
    const inScopeWithIdentity = (node: SearchableEntry, all: readonly SearchableEntry[]) =>
      Boolean(
        node.element &&
        isFocusEditableElement(node.properties) &&
        !this.focusIdentitySignals(target, node.element, labelText).conflict &&
        sameChain(identifiedAncestorChain(node, all), scope),
      );
    // The scope must single the field out before the tap, or it identifies nothing.
    if (
      distinctFocusFields(preNodes.filter((node) => inScopeWithIdentity(node, preNodes))).length !==
      1
    ) {
      return false;
    }
    // After the tap that field must be the only focused one, and every copy of it (a
    // capture can serialize one field under several roots) must agree on its identity
    // and its focus.
    const inScope = nodes.filter((node) => inScopeWithIdentity(node, nodes));
    const focused = nodes.filter(
      (node) =>
        node.element &&
        isFocusEditableElement(node.properties) &&
        isElementKeyboardFocused(node.element),
    );
    return (
      distinctFocusFields(inScope).length === 1 &&
      inScope.every((node) => isElementKeyboardFocused(node.element!)) &&
      focused.every((node) => inScope.includes(node))
    );
  }

  /** The pre-tap capture is fixed across post-tap re-reads; project it once. */
  private projectPreTapHierarchy(hierarchy: ViewHierarchyResult): readonly SearchableEntry[] {
    const cached = this.preTapProjections.get(hierarchy);
    if (cached) {
      return cached;
    }
    const projected = this.focusProjection.project(
      resolveViewHierarchyForSearch(hierarchy) ?? hierarchy,
    );
    this.preTapProjections.set(hierarchy, projected);
    return projected;
  }

  private matchFocusedInputTarget(
    options: TapOnElementOptions,
    scopedOptions: TapVerificationOptions,
    target: Element,
    viewHierarchy: ViewHierarchyResult,
    nodes: readonly SearchableEntry[],
    {
      labelText,
      selectedIndex,
      preTapHierarchy,
      screenHeight,
    }: {
      labelText?: string;
      selectedIndex?: number;
      preTapHierarchy?: ViewHierarchyResult;
      screenHeight?: number;
    },
  ): boolean {
    const identifier = findFocusIdentifier(target, nodes);
    if (identifier?.shared) {
      return this.verifyIndexedFocusTarget(
        scopedOptions,
        target,
        viewHierarchy,
        identifier,
        selectedIndex,
      );
    }
    const iosNativeEditorFallback = () =>
      this.deps.device.platform === "ios" &&
      Boolean(findSoleExpandedNativeFocusField(target, nodes, screenHeight, labelText));
    if (identifier) {
      return (
        nodes.some(
          (node) =>
            node.element &&
            isFocusEditableElement(node.properties) &&
            isElementKeyboardFocused(node.element) &&
            node.element[identifier.key] === identifier.value &&
            isSameFocusTarget(target, node.element, nodes),
        ) || iosNativeEditorFallback()
      );
    }
    const focused = nodes.find((node) => this.isFocusedMatchingNode(target, node, nodes));
    if (focused) {
      return true;
    }
    if (this.findSoleFocusedFieldByStableIdentity(target, nodes, labelText, preTapHierarchy)) {
      return true;
    }
    if (this.findSoleFocusedFieldAtTargetBounds(target, nodes, labelText)) {
      return true;
    }
    if (iosNativeEditorFallback()) {
      return true;
    }
    if (!options.testTag && !(options.elementId && target["resource-id"])) {
      return false;
    }
    return this.isRefoundFocusTarget(scopedOptions, target, viewHierarchy);
  }
}
