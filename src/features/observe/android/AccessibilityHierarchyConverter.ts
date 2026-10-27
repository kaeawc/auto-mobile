import type { ViewHierarchyResult } from "../../../models";
import { panelFingerprintFromWire } from "../../../models/DisplayPanel";
import { screenScaleMetadataSpread } from "../../../models/ScreenScaleMetadata";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { parsePrototypeHiddenReason } from "../../prototype/prototypeHidden";
import { linkWindowRoots } from "../linkWindowRoots";
import { normalizeHierarchyOptionalFields } from "../truncationReasons";
import { applyStableViewIdRewrites, assignStableViewIds } from "./StableNodeIdentity";
import type { AccessibilityHierarchy, AccessibilityNode, HierarchyDelegateContext } from "./types";

/**
 * The bound service's runtime `isAccessibilityTool` (#6233), carried only when the runner reported a
 * boolean; the runner serializes an unknown value as JSON null, which stays omitted (unknown).
 */
function accessibilityToolSpread(hierarchy: AccessibilityHierarchy): {
  accessibilityTool?: boolean;
} {
  return typeof hierarchy.accessibilityTool === "boolean"
    ? { accessibilityTool: hierarchy.accessibilityTool }
    : {};
}
/** Converts runner hierarchy metadata and nodes into the public observation shape. */
export class AccessibilityHierarchyConverter {
  constructor(private readonly context: Pick<HierarchyDelegateContext, "timer">) {}

  /**
   * Convert accessibility service hierarchy format to ViewHierarchyResult format.
   */
  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    const startTime = this.context.timer.now();

    try {
      logger.debug(
        "[CTRL_PROXY] Converting accessibility service format to ViewHierarchyResult format",
      );

      const hierarchyToConvert: AccessibilityNode | undefined = accessibilityHierarchy.hierarchy;
      const resolvedPackageName = accessibilityHierarchy.packageName;

      if (!hierarchyToConvert) {
        const errorMessage =
          accessibilityHierarchy.error ||
          "Accessibility hierarchy missing from accessibility service";
        return normalizeHierarchyOptionalFields({
          captureSequence: accessibilityHierarchy.captureSequence,
          displayId: accessibilityHierarchy.displayId,
          panelUniqueId: accessibilityHierarchy.panelUniqueId,
          panelFingerprint: panelFingerprintFromWire(accessibilityHierarchy.panelFingerprint),
          hierarchy: {
            error: errorMessage,
          },
          packageName: resolvedPackageName,
          windows: accessibilityHierarchy.windows,
          ...(accessibilityHierarchy.prototypeSuspended === true
            ? { prototypeSuspended: true }
            : {}),
          ...(parsePrototypeHiddenReason(accessibilityHierarchy.prototypeHiddenReason)
            ? {
                prototypeHiddenReason: parsePrototypeHiddenReason(
                  accessibilityHierarchy.prototypeHiddenReason,
                ),
              }
            : {}),
          contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
          intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
          notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
          ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
          ctrlProxyIncompleteReason: accessibilityHierarchy.ctrlProxyIncompleteReason,
          truncationReasons: accessibilityHierarchy.truncationReasons,
          sources: ["control-proxy"],
          screenWidth: accessibilityHierarchy.screenWidth,
          screenHeight: accessibilityHierarchy.screenHeight,
          rotation: accessibilityHierarchy.rotation,
          systemInsets: accessibilityHierarchy.systemInsets,
          insets: accessibilityHierarchy.insets,
          // The API level decides whether a rootless incomplete capture can be Android 14+
          // data-sensitive withholding (issue #6151), so keep it on this branch too.
          sdkInt: accessibilityHierarchy.sdkInt,
          ...accessibilityToolSpread(accessibilityHierarchy),
          // Carry the #4548 scale metadata through the rootless / UIAutomator-fallback branch too,
          // so #4549 can consume it regardless of which route produced the hierarchy. Same
          // all-or-nothing validator as the main return and client retention.
          ...screenScaleMetadataSpread(accessibilityHierarchy),
        });
      }

      // Convert the accessibility node format
      const convertedHierarchy = this.convertAccessibilityNode(hierarchyToConvert);

      // Capture-layer stable node identity (issue #3228): rewrite the runner's
      // positional (path-derived UUID) view-ids into content-derived stable ids
      // so id-less rows keep their identity across a scroll and the diff
      // layer's content-identity re-pair can collapse scroll churn.
      const hierarchyViewIdRewrites = assignStableViewIds(convertedHierarchy);

      // Convert accessibility-focused element if present
      const accessibilityFocusedElement = accessibilityHierarchy["accessibility-focused-element"]
        ? this.convertAccessibilityNode(accessibilityHierarchy["accessibility-focused-element"])
        : undefined;
      // Reuse the hierarchy rewrite map first so mirror links point at the exact
      // ids emitted in the hierarchy, including occluders outside the mirror.
      applyStableViewIdRewrites(accessibilityFocusedElement, hierarchyViewIdRewrites);
      // Fallback for mirrors that contain generated ids absent from the hierarchy
      // map; resource-id-backed and already-rewritten ids are left untouched.
      assignStableViewIds(accessibilityFocusedElement);

      const result: ViewHierarchyResult = {
        captureSequence: accessibilityHierarchy.captureSequence,
        displayId: accessibilityHierarchy.displayId,
        panelUniqueId: accessibilityHierarchy.panelUniqueId,
        panelFingerprint: panelFingerprintFromWire(accessibilityHierarchy.panelFingerprint),
        hierarchy: convertedHierarchy,
        packageName: resolvedPackageName,
        windows: linkWindowRoots(convertedHierarchy, accessibilityHierarchy.windows),
        ...(accessibilityHierarchy.prototypeSuspended === true ? { prototypeSuspended: true } : {}),
        ...(parsePrototypeHiddenReason(accessibilityHierarchy.prototypeHiddenReason)
          ? {
              prototypeHiddenReason: parsePrototypeHiddenReason(
                accessibilityHierarchy.prototypeHiddenReason,
              ),
            }
          : {}),
        contentHiddenRegions: accessibilityHierarchy.contentHiddenRegions,
        intentChooserDetected: accessibilityHierarchy.intentChooserDetected,
        notificationPermissionDetected: accessibilityHierarchy.notificationPermissionDetected,
        "accessibility-focused-element": accessibilityFocusedElement,
        ctrlProxyIncomplete: accessibilityHierarchy.ctrlProxyIncomplete,
        ctrlProxyIncompleteReason: accessibilityHierarchy.ctrlProxyIncompleteReason,
        sources: ["control-proxy"],
        screenWidth: accessibilityHierarchy.screenWidth,
        screenHeight: accessibilityHierarchy.screenHeight,
        rotation: accessibilityHierarchy.rotation,
        systemInsets: accessibilityHierarchy.systemInsets,
        insets: accessibilityHierarchy.insets,
        wakefulness: accessibilityHierarchy.wakefulness,
        foregroundActivity: accessibilityHierarchy.foregroundActivity,
        density: accessibilityHierarchy.density,
        sdkInt: accessibilityHierarchy.sdkInt,
        deviceModel: accessibilityHierarchy.deviceModel,
        isEmulator: accessibilityHierarchy.isEmulator,
        ...accessibilityToolSpread(accessibilityHierarchy),
        truncationReasons: accessibilityHierarchy.truncationReasons,
        // Additive scale metadata (#4548), retained for #4549. All-or-nothing via the shared
        // validator (same rule as client retention): the three keys are spread only when the whole
        // tuple is complete-finite-positive, and omitted entirely otherwise — so a partial or
        // legacy payload (the runner serializes absent optionals as JSON null) stays byte-identical.
        ...screenScaleMetadataSpread(accessibilityHierarchy),
      };

      const duration = this.context.timer.now() - startTime;
      logger.debug(`[CTRL_PROXY] Format conversion completed in ${duration}ms`);

      return normalizeHierarchyOptionalFields(result);
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(
        `[CTRL_PROXY] Format conversion failed after ${duration}ms: ${errorMessage(error)}`,
        error,
      );

      return {
        ...(parsePrototypeHiddenReason(accessibilityHierarchy.prototypeHiddenReason)
          ? {
              prototypeHiddenReason: parsePrototypeHiddenReason(
                accessibilityHierarchy.prototypeHiddenReason,
              ),
            }
          : {}),
        ...(accessibilityHierarchy.prototypeSuspended === true ? { prototypeSuspended: true } : {}),
        hierarchy: {
          error: "Failed to convert accessibility service hierarchy format",
        },
      };
    }
  }

  private copyNodeIdentity(node: AccessibilityNode, converted: any): void {
    if (Number.isInteger(node.windowId)) {
      converted.windowId = node.windowId;
    }

    if (node.actions) {
      converted.actions = node.actions;
    }

    // Copy over all properties
    if (node.text) {
      converted.text = node.text;
    }
    if (node["content-desc"]) {
      converted["content-desc"] = node["content-desc"];
    }
    if (node["resource-id"]) {
      converted["resource-id"] = node["resource-id"];
    }
    if (node["test-tag"]) {
      converted["test-tag"] = node["test-tag"];
    }
    if (node["unique-id"]) {
      converted["unique-id"] = node["unique-id"];
    }
    if (typeof node["collection-row-index"] === "number") {
      converted["collection-row-index"] = node["collection-row-index"];
    }
    if (typeof node["collection-column-index"] === "number") {
      converted["collection-column-index"] = node["collection-column-index"];
    }
    if (typeof node["visible-to-user"] === "boolean") {
      converted["visible-to-user"] = node["visible-to-user"];
    }
  }

  private copyNodeDescriptions(node: AccessibilityNode, converted: any): void {
    if (node["container-title"]) {
      converted["container-title"] = node["container-title"];
    }
    for (const key of [
      "hint-text",
      "state-description",
      "error-message",
      "tooltip-text",
      "pane-title",
      "live-region",
      "collection-info",
      "collection-item-info",
      "range-info",
    ] as const) {
      if (node[key]) {
        converted[key] = node[key];
      }
    }
    if (node["view-id"]) {
      converted["view-id"] = node["view-id"];
    }
    if (node.className) {
      converted.class = node.className;
      converted.className = node.className;
    }
    if (node.packageName) {
      converted.packageName = node.packageName;
    }
  }

  private copyNodeFocusState(node: AccessibilityNode, converted: any): void {
    if (node.clickable && node.clickable !== "false") {
      converted.clickable = node.clickable;
    }
    // Absence (including a wire null) means enabled; preserve explicit disabled state.
    if (node.enabled !== undefined && node.enabled !== null) {
      converted.enabled = node.enabled;
    }
    if (node.focusable && node.focusable !== "false") {
      converted.focusable = node.focusable;
    }
    if (node.focused && node.focused !== "false") {
      converted.focused = node.focused;
    }
    if (node.scrollable && node.scrollable !== "false") {
      converted.scrollable = node.scrollable;
    }
  }

  private copyNodeSelectionState(node: AccessibilityNode, converted: any): void {
    if (node.password && node.password !== "false") {
      converted.password = node.password;
    }
    if (node.checkable && node.checkable !== "false") {
      converted.checkable = node.checkable;
    }
    if (node.checked && node.checked !== "false") {
      converted.checked = node.checked;
    }
    if (node.selected && node.selected !== "false") {
      converted.selected = node.selected;
    }
    if (node["long-clickable"] && node["long-clickable"] !== "false") {
      converted["long-clickable"] = node["long-clickable"];
    }
  }

  private copyNodePresentation(node: AccessibilityNode, converted: any): void {
    if (node["semantic-links"] && node["semantic-links"].length > 0) {
      converted["semantic-links"] = node["semantic-links"];
    }

    if (node.occlusionState) {
      converted.occlusionState = node.occlusionState;
    }
    if (node.occludedBy) {
      converted.occludedBy = node.occludedBy;
    }
    if (node.occludedByViewId) {
      converted.occludedByViewId = node.occludedByViewId;
    }
    if (node.extras) {
      converted.extras = node.extras;
    }
    if (node.recomposition) {
      converted.recomposition = node.recomposition;
    }
    // Reported text size in px (ExtraRenderingInfo.textSizeInPx, API 30+); the contrast
    // checker converts to dp with the observation density (#10134).
    if (typeof node.textSize === "number" && Number.isFinite(node.textSize) && node.textSize > 0) {
      converted.textSize = node.textSize;
    }

    if (node.bounds) {
      converted.bounds = node.bounds;
    }
  }

  /**
   * Convert individual accessibility node to the expected format.
   */
  private convertAccessibilityNode(node: AccessibilityNode | AccessibilityNode[]): any {
    // Handle array of nodes
    if (Array.isArray(node)) {
      const convertedArray = node.map((child) => this.convertAccessibilityNode(child));
      return convertedArray.length === 1 ? convertedArray[0] : convertedArray;
    }

    const converted: any = {};
    this.copyNodeIdentity(node, converted);
    this.copyNodeDescriptions(node, converted);
    this.copyNodeFocusState(node, converted);
    this.copyNodeSelectionState(node, converted);
    this.copyNodePresentation(node, converted);
    // Convert child nodes recursively
    if (node.node) {
      converted.node = this.convertAccessibilityNode(node.node);
    }

    return converted;
  }
}
