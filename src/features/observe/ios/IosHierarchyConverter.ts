import { normalizeHierarchyOptionalFields } from "../truncationReasons";
/**
 * CtrlProxy iOSHierarchy - Delegate for hierarchy operations.
 *
 * This delegate handles hierarchy retrieval, caching, and conversion
 * via the iOS CtrlProxy iOS WebSocket API.
 */

import type { SemanticLink, ViewHierarchyResult } from "../../../models";
import { nodeAttributes } from "../../../models/ViewHierarchyResult";
import { screenScaleMetadataSpread } from "../../../models/ScreenScaleMetadata";
import { hasIosHeaderTrait } from "./semanticRoles";
import { IOS_WINDOW_LAYER_EXTRA } from "./iosWindowLayer";
import { assignIosStableViewIds, GENERATED_VIEW_ID_PATTERN } from "../android/StableNodeIdentity";
import type { CtrlProxyNode, XCTestHierarchy } from "./types";

/** Converted node format — `$` carries standard attributes, `extras` carries SDK walker data. */
export interface ConvertedNode {
  $: Record<string, unknown>;
  extras?: Record<string, string>;
  node?: ConvertedNode[];
}

/** Pure conversion and filtering of a raw CtrlProxy hierarchy into the Android-compatible shape. */
export class IosHierarchyConverter {
  /** Typed view of the node predicates and attribute cleaner that unit tests pin directly. */
  get testHooks() {
    return {
      cleanAttributes: (attrs: Record<string, unknown>) => this.cleanAttributes(attrs),
      hasContentProperties: (attrs: Record<string, unknown>) => this.hasContentProperties(attrs),
      isRedundantStaticTextChild: (parentText: string, child: ConvertedNode) =>
        this.isRedundantStaticTextChild(parentText, child),
      noiseSiblingKey: (node: ConvertedNode) => this.noiseSiblingKey(node),
      filterRootNode: (node: ConvertedNode) => this.filterHierarchyNode(node, true),
    };
  }

  /**
   * Convert XCTestHierarchy to ViewHierarchyResult format.
   */
  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult {
    // Convert to Android-compatible format
    const convertedNode = this.convertNode(hierarchy.hierarchy);

    // Apply filtering to reduce hierarchy size (similar to Android's optimizeHierarchy)
    const filteredNode = this.filterHierarchyNode(convertedNode, true);

    // CtrlProxy emits a path-derived UUID for nodes without an accessibility
    // identifier. Rewrite those generated ids at ingest just as the Android
    // converter does, so an iOS skeleton elementId is directly resolvable by
    // the shared element selector rather than advertising an opaque UUID.
    // SDK-only children can move between parents as the SDK snapshot catches up
    // with XCUITest frames. Their sdk.source marker survives beside $ in extras.
    assignIosStableViewIds(filteredNode);

    return normalizeHierarchyOptionalFields({
      hierarchy: {
        node: filteredNode ?? undefined,
      },
      packageName: hierarchy.packageName,
      ...(hierarchy.fallbackToSpringboard !== undefined
        ? { fallbackToSpringboard: hierarchy.fallbackToSpringboard }
        : {}),
      updatedAt: hierarchy.updatedAt,
      windows: hierarchy.windows,
      // iOS screen scale factor (e.g., 2.0 for @2x, 3.0 for @3x retina)
      screenScale: hierarchy.screenScale,
      // Screen dimensions in iOS points (logical pixels)
      screenWidth: hierarchy.screenWidth,
      screenHeight: hierarchy.screenHeight,
      // Additive scale metadata (#4548): UIScreen.nativeScale + physical screenshot pixel
      // dimensions. All-or-nothing via the shared validator (same rule as client retention): the
      // three keys are spread only when the whole tuple is complete-finite-positive, and omitted
      // entirely otherwise — so payloads from pre-#4548 runners stay byte-identical.
      ...screenScaleMetadataSpread(hierarchy),
      rotation: hierarchy.rotation,
      systemInsets: hierarchy.systemInsets,
      insets: hierarchy.insets,
      ...(hierarchy.truncationReasons && { truncationReasons: hierarchy.truncationReasons }),
    });
  }

  // ===========================================================================
  // Private helper methods
  // ===========================================================================

  private convertNode(node: CtrlProxyNode): ConvertedNode {
    const attrs: Record<string, unknown> = {};

    if (node.text) {
      attrs["text"] = node.text;
    }
    // The runner sends "" for an empty editable (vs. omitting an unreadable one), so keep it (#9078).
    if (typeof node.value === "string") {
      attrs["value"] = node.value;
    }
    const fields = this.readConversionFields(node);
    this.assignContentAttributes(node, attrs, fields);
    this.assignInteractionAttributes(node, attrs, fields);
    this.assignSemanticAttributes(node, attrs, fields);

    const result: ConvertedNode = { $: attrs };

    if (node.extras && Object.keys(node.extras).length > 0) {
      result.extras = node.extras;
    }

    if (node.node) {
      const children = Array.isArray(node.node) ? node.node : [node.node];
      result.node = children.map((child) => this.convertNode(child));
    }

    return result;
  }

  private readConversionFields(node: CtrlProxyNode) {
    const contentDesc = this.readNodeField<string>(node, "contentDesc", "content-desc");
    const resourceId = this.readNodeField<string>(node, "resourceId", "resource-id");
    const testTag = this.readNodeField<string>(node, "testTag", "test-tag");
    const accessibilityFocused = this.readNodeField<string>(
      node,
      "accessibilityFocused",
      "accessibility-focused",
    );
    const longClickable = this.readNodeField<string>(node, "longClickable", "long-clickable");
    const semanticLinks = this.readNodeField<SemanticLink[]>(
      node,
      "semanticLinks",
      "semantic-links",
    );
    const stateDescription = this.readNodeField<string>(
      node,
      "stateDescription",
      "state-description",
    );
    const errorMessage = this.readNodeField<string>(node, "errorMessage", "error-message");
    const hintText = this.readNodeField<string>(node, "hintText", "hint-text");
    const viewId = this.readNodeField<string>(node, "viewId", "view-id");

    return {
      contentDesc,
      resourceId,
      testTag,
      accessibilityFocused,
      longClickable,
      semanticLinks,
      stateDescription,
      errorMessage,
      hintText,
      viewId,
    };
  }

  private assignContentAttributes(
    node: CtrlProxyNode,
    attrs: Record<string, unknown>,
    fields: ReturnType<IosHierarchyConverter["readConversionFields"]>,
  ): void {
    const { contentDesc, resourceId, testTag } = fields;
    if (contentDesc) {
      attrs["content-desc"] = contentDesc;
    }
    if (resourceId) {
      attrs["resource-id"] = resourceId;
    }
    if (node.className) {
      attrs["class"] = node.className;
    }
    if (testTag) {
      attrs["test-tag"] = testTag;
    }
    if (node.bounds) {
      attrs["bounds"] = node.bounds;
    }
    if (node.clickable) {
      attrs["clickable"] = node.clickable;
    }
    if (node.enabled) {
      attrs["enabled"] = node.enabled;
    }
    if (node.focusable) {
      attrs["focusable"] = node.focusable;
    }
  }

  private assignInteractionAttributes(
    node: CtrlProxyNode,
    attrs: Record<string, unknown>,
    fields: ReturnType<IosHierarchyConverter["readConversionFields"]>,
  ): void {
    const { accessibilityFocused, longClickable } = fields;
    if (node.focused) {
      attrs["focused"] = node.focused;
    }
    if (accessibilityFocused) {
      attrs["accessibility-focused"] = accessibilityFocused;
    }
    if (node.scrollable) {
      attrs["scrollable"] = node.scrollable;
    }
    if (node.password) {
      attrs["password"] = node.password;
    }
    if (node.checkable) {
      attrs["checkable"] = node.checkable;
    }
    if (node.checked) {
      attrs["checked"] = node.checked;
    }
    if (node.selected) {
      attrs["selected"] = node.selected;
    }
    if (longClickable) {
      attrs["long-clickable"] = longClickable;
    }
  }

  private assignSemanticAttributes(
    node: CtrlProxyNode,
    attrs: Record<string, unknown>,
    fields: ReturnType<IosHierarchyConverter["readConversionFields"]>,
  ): void {
    const { semanticLinks, stateDescription, errorMessage, hintText, viewId } = fields;
    if (semanticLinks && semanticLinks.length > 0) {
      attrs["semantic-links"] = semanticLinks;
    }
    if (hasIosHeaderTrait(node.extras)) {
      attrs["role"] = "heading";
    } else if (node.role) {
      attrs["role"] = node.role;
    }
    if (stateDescription) {
      attrs["state-description"] = stateDescription;
    }
    if (errorMessage) {
      attrs["error-message"] = errorMessage;
    }
    if (hintText) {
      attrs["hint-text"] = hintText;
    }
    if (viewId) {
      attrs["view-id"] = viewId;
    }
    if (node.actions && node.actions.length > 0) {
      attrs["actions"] = node.actions;
    }
  }

  private readNodeField<T>(
    node: CtrlProxyNode,
    camelKey: keyof CtrlProxyNode,
    dashedKey?: string,
  ): T | undefined {
    const record = node as Record<string, unknown>;
    if (record[camelKey as string] !== undefined) {
      return record[camelKey as string] as T;
    }
    if (dashedKey && record[dashedKey] !== undefined) {
      return record[dashedKey] as T;
    }
    return undefined;
  }

  /**
   * Check if a node has meaningful content (text, identifier, test-tag)
   */
  private hasContentProperties(attrs: Record<string, unknown>): boolean {
    const contentFields = ["text", "value", "resource-id", "content-desc", "test-tag", "role"];
    return Boolean(
      contentFields.some((field) => attrs[field] && attrs[field] !== "") ||
      this.hasMeaningfulViewId(attrs),
    );
  }

  /**
   * Check if a node has meaningful interaction properties
   * Note: iOS marks many containers as clickable, so we're more selective here
   */
  private hasInteractionProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["scrollable"] === "true" ||
      attrs["focused"] === "true" ||
      attrs["accessibility-focused"] === "true" ||
      attrs["selected"] === "true" ||
      attrs["checked"] === "true",
    );
  }

  /**
   * Check if a node is a structural wrapper (UIView with no meaningful properties)
   */
  private isStructuralWrapper(attrs: Record<string, unknown>, hasChildren: boolean): boolean {
    const className = typeof attrs["class"] === "string" ? attrs["class"] : "";
    const isContainerClass =
      className === "UIWindow" || className === "UIView" || className === "UIImageView";

    // Not a wrapper if it has content or is focused/selected/scrollable
    if (this.hasContentProperties(attrs) || this.hasInteractionProperties(attrs)) {
      return false;
    }

    // Container classes without content are wrappers if they have children
    // UIImageView without text is decorative and can be collapsed
    return isContainerClass && hasChildren;
  }

  /**
   * Clean node attributes by removing false booleans and empty values
   */
  private cleanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    const booleanFields = [
      "clickable",
      "enabled",
      "focusable",
      "focused",
      "accessibility-focused",
      "scrollable",
      "password",
      "checkable",
      "checked",
      "selected",
      "long-clickable",
    ];

    for (const [key, value] of Object.entries(attrs)) {
      // Skip empty values, except `value`: the runner only sends "" for an empty editable, where it
      // distinguishes "empty" from "unreadable" (#9078).
      if ((value === "" && key !== "value") || value === null || value === undefined) {
        continue;
      }

      // Skip false boolean values
      if (key !== "enabled" && booleanFields.includes(key) && value === "false") {
        continue;
      }

      // Skip enabled=true (it's the default)
      if (key === "enabled" && value === "true") {
        continue;
      }

      cleaned[key] = value;
    }

    return cleaned;
  }

  /**
   * Filter hierarchy node - removes structural wrappers and nodes without meaningful properties
   * Similar to Android's optimizeHierarchy + filterViewHierarchy
   */
  private filterHierarchyNode(node: ConvertedNode, isRoot: true): ConvertedNode | null;
  private filterHierarchyNode(
    node: ConvertedNode,
    isRoot?: false,
    insideSpringBoardIcon?: boolean,
  ): ConvertedNode | ConvertedNode[] | null;
  private filterHierarchyNode(
    node: ConvertedNode,
    isRoot: boolean = false,
    insideSpringBoardIcon: boolean = false,
  ): ConvertedNode | ConvertedNode[] | null {
    const attrs = nodeAttributes(node);
    const children = node.node || [];

    // XCTest exposes the title/artwork of a SpringBoard icon as tappable
    // UIImageView leaves. The enclosing SBIconView is the actual tap target.
    // This relationship survives wrapper promotion and does not depend on the
    // icon already having a label or clickable flag in the runner snapshot.
    if (insideSpringBoardIcon && this.isIconArtworkImage(node)) {
      return null;
    }
    const inIcon = insideSpringBoardIcon || attrs["class"] === "SBIconView";

    // Root node is always kept
    if (isRoot) {
      return this.filterRootNode(node, attrs, children, inIcon);
    }

    // Process children first (recursively)
    const filteredChildren = this.filterHierarchyChildren(children, inIcon);
    const compactedChildren = this.dropRedundantStaticTextChildren(attrs, filteredChildren);
    const dedupedChildren = this.dedupeNoiseSiblings(compactedChildren);

    // Check if this node is a structural wrapper
    if (this.isStructuralWrapper(attrs, dedupedChildren.length > 0)) {
      // Promote children (collapse this wrapper)
      if (dedupedChildren.length > 0) {
        // Return children to be flattened into parent
        return dedupedChildren;
      }
      // No children and no content - filter out completely
      return null;
    }

    // Check if node has any meaningful properties
    // Keep node if:
    // 1. Has content (text, identifier, etc.)
    // 2. Has interaction properties (scrollable, focused, selected)
    // 3. Is clickable and is a leaf node (actual tappable element)
    // 4. Has meaningful filtered children
    const keepNode = this.hasMeaningfulFilteredNode(attrs, dedupedChildren);

    if (!keepNode) {
      return null;
    }

    return this.buildFilteredNode(node, attrs, dedupedChildren);
  }

  private filterHierarchyChildren(children: ConvertedNode[], inIcon: boolean): ConvertedNode[] {
    const filteredChildren: ConvertedNode[] = [];
    for (const child of children) {
      const filtered = this.filterHierarchyNode(child, false, inIcon);
      if (filtered) {
        // If child filtering returned an array (promoted grandchildren), flatten it
        if (Array.isArray(filtered)) {
          filteredChildren.push(...filtered);
        } else {
          filteredChildren.push(filtered);
        }
      }
    }
    return filteredChildren;
  }

  /** The root's children are filtered per UIWindow so their window order can be stamped. */
  private filterRootNode(
    node: ConvertedNode,
    attrs: Record<string, unknown>,
    children: ConvertedNode[],
    inIcon: boolean,
  ): ConvertedNode {
    const { nodes, windowOrigins } = this.filterRootChildren(children, inIcon);
    const compactedChildren = this.dropRedundantStaticTextChildren(attrs, nodes);
    const dedupedChildren = this.dedupeNoiseSiblings(compactedChildren);
    this.stampWindowLayers(dedupedChildren, windowOrigins);
    return this.buildFilteredNode(node, attrs, dedupedChildren);
  }

  /** Like filterHierarchyChildren, also recording which root UIWindow each survivor came from. */
  private filterRootChildren(
    children: ConvertedNode[],
    inIcon: boolean,
  ): { nodes: ConvertedNode[]; windowOrigins: Map<ConvertedNode, number> } {
    const perChild = children.map((child, index) => ({
      index,
      isWindow: nodeAttributes(child)["class"] === "UIWindow",
      survivors: this.filterHierarchyChildren([child], inIcon),
    }));
    return {
      nodes: perChild.flatMap(({ survivors }) => survivors),
      windowOrigins: new Map(
        perChild
          .filter(({ isWindow }) => isWindow)
          .flatMap(({ index, survivors }) => survivors.map((node) => [node, index] as const)),
      ),
    };
  }

  /** See iosWindowLayer.ts: stamp front-to-back window order once two windows contribute nodes. */
  private stampWindowLayers(
    children: ConvertedNode[],
    windowOrigins: ReadonlyMap<ConvertedNode, number>,
  ): void {
    const windows = [...new Set(children.flatMap((child) => windowOrigins.get(child) ?? []))].sort(
      (a, b) => b - a,
    );
    if (windows.length < 2) {
      return;
    }
    for (const child of children) {
      const origin = windowOrigins.get(child);
      if (origin !== undefined) {
        child.extras = {
          ...child.extras,
          [IOS_WINDOW_LAYER_EXTRA]: String(windows.indexOf(origin)),
        };
      }
    }
  }

  private buildFilteredNode(
    node: ConvertedNode,
    attrs: Record<string, unknown>,
    dedupedChildren: ConvertedNode[],
  ): ConvertedNode {
    const cleanedAttrs = this.cleanAttributes(attrs);
    const result: ConvertedNode = { $: cleanedAttrs };
    if (node.extras) {
      result.extras = node.extras;
    }
    if (dedupedChildren.length > 0) {
      result.node = dedupedChildren;
    }
    return result;
  }

  private hasMeaningfulFilteredNode(
    attrs: Record<string, unknown>,
    children: ConvertedNode[],
  ): boolean {
    const hasContent = this.hasContentProperties(attrs);
    const hasInteraction = this.hasInteractionProperties(attrs);
    const isClickable = attrs["clickable"] === "true";
    return (
      hasContent || hasInteraction || (isClickable && children.length === 0) || children.length > 0
    );
  }

  private isIconArtworkImage(node: ConvertedNode): boolean {
    const attrs = nodeAttributes(node);
    const protectedFields = [
      "text",
      "hint-text",
      "semantic-links",
      "state-description",
      "error-message",
      "actions",
    ];
    return (
      attrs["class"] === "UIImageView" &&
      !node.node?.length &&
      !node.extras &&
      !protectedFields.some((field) => Boolean(attrs[field])) &&
      !this.hasStandaloneContentProperties(attrs) &&
      !this.hasStateProperties(attrs) &&
      attrs["long-clickable"] !== "true" &&
      attrs["checkable"] !== "true"
    );
  }

  private dedupeNoiseSiblings(children: ConvertedNode[]): ConvertedNode[] {
    const seen = new Set<string>();
    const result: ConvertedNode[] = [];

    for (const child of children) {
      const key = this.noiseSiblingKey(child);
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      result.push(child);
    }

    return result;
  }

  private dropRedundantStaticTextChildren(
    parentAttrs: Record<string, unknown>,
    children: ConvertedNode[],
  ): ConvertedNode[] {
    const parentText = this.normalizedText(parentAttrs["text"]);
    if (!parentText || !this.canOwnStaticText(parentAttrs)) {
      return children;
    }

    return children.filter((child) => !this.isRedundantStaticTextChild(parentText, child));
  }

  private canOwnStaticText(attrs: Record<string, unknown>): boolean {
    const role = typeof attrs["role"] === "string" ? attrs["role"] : "";
    return (
      attrs["clickable"] === "true" || role === "button" || role === "link" || role === "listitem"
    );
  }

  private hasChildrenOrExtras(node: ConvertedNode): boolean {
    if (node.node && node.node.length > 0) {
      return true;
    }
    if (node.extras && Object.keys(node.extras).length > 0) {
      return true;
    }
    return false;
  }

  private isRedundantStaticTextChild(parentText: string, child: ConvertedNode): boolean {
    if (this.hasChildrenOrExtras(child)) {
      return false;
    }

    const attrs = nodeAttributes(child);
    const className = typeof attrs["class"] === "string" ? attrs["class"] : "";
    const role = typeof attrs["role"] === "string" ? attrs["role"] : "";
    if (className !== "UILabel" || (role !== "" && role !== "text")) {
      return false;
    }
    if (this.normalizedText(attrs["text"]) !== parentText) {
      return false;
    }
    if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
      return false;
    }
    if (this.hasStateProperties(attrs) || this.hasDirectActionProperties(attrs)) {
      return false;
    }

    return !this.hasStandaloneContentProperties(attrs);
  }

  private hasStandaloneContentProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      (attrs["value"] && attrs["value"] !== "") ||
      (attrs["resource-id"] && attrs["resource-id"] !== "") ||
      (attrs["content-desc"] && attrs["content-desc"] !== "") ||
      (attrs["test-tag"] && attrs["test-tag"] !== "") ||
      this.hasMeaningfulViewId(attrs),
    );
  }

  private hasMeaningfulViewId(attrs: Record<string, unknown>): boolean {
    const viewId = attrs["view-id"];
    return typeof viewId === "string" && viewId !== "" && !GENERATED_VIEW_ID_PATTERN.test(viewId);
  }

  private hasDirectActionProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["clickable"] === "true" ||
      attrs["focusable"] === "true" ||
      attrs["long-clickable"] === "true" ||
      attrs["checkable"] === "true",
    );
  }

  private hasStateProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["scrollable"] === "true" ||
      attrs["focused"] === "true" ||
      attrs["accessibility-focused"] === "true" ||
      attrs["selected"] === "true" ||
      attrs["checked"] === "true",
    );
  }

  private normalizedText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private noiseSiblingKey(node: ConvertedNode): string | null {
    if (this.hasChildrenOrExtras(node)) {
      return null;
    }

    const attrs = nodeAttributes(node);
    if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
      return null;
    }
    if (this.hasStateProperties(attrs)) {
      return null;
    }

    const text = typeof attrs["text"] === "string" ? attrs["text"].trim().toLowerCase() : "";
    const isKnownNoise = text.includes("scroll bar") || text === "dictate" || text === "dictation";
    if (!isKnownNoise) {
      return null;
    }

    return JSON.stringify([
      ...["class", "text", "resource-id"].map((field) => attrs[field] ?? ""),
      attrs["bounds"] ?? null,
    ]);
  }
}
