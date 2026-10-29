import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import { nodeAttributes, nodeBounds } from "../../../models/ViewHierarchyResult";
import { boundsKey, childrenOf, removeCoveredLeaves } from "./iosSdkObservationMerge";
import type { IosSdkWebElement, IosSdkWebSnapshot } from "./sdkWebViewBridge";
import { WEB_SNAPSHOT_ID_ATTRIBUTE } from "../../../utils/hierarchyFingerprint";

/**
 * Merges iOS SDK WKWebView snapshots into the XCTest hierarchy (#5162).
 *
 * Each opted-in web view's allowed-origin DOM elements are attached as children of its WKWebView
 * node. They map onto the existing attributes (`label` → `content-desc`, `value` → `text`, `role`
 * → `class`), so the shared selector schema and resolver match them unchanged. Each also carries
 * the web view, snapshot and element ids an action needs, and the page's origin. XCTest leaves a
 * DOM element already covers (same bounds and the same label or value) are removed.
 */

export const IOS_SDK_WEB_SOURCE = "sdkWebBridge";
export const WEB_VIEW_ID_ATTRIBUTE = "web-view-id";
export { WEB_SNAPSHOT_ID_ATTRIBUTE };
export const WEB_ELEMENT_ID_ATTRIBUTE = "web-element-id";
export const WEB_ORIGIN_ATTRIBUTE = "web-origin";

/**
 * DOM roles of text entry fields. They are reported with `role: textfield`, as an XCTest text field
 * would be, so focus and sendKeys targeting still treat a merged field as editable after its XCTest
 * duplicate is removed. A snapshot carries no input type, so a non-text `<input>` counts too.
 */
const EDITABLE_WEB_ROLES: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "textbox",
  "searchbox",
  "combobox",
]);

/** The class CtrlProxy reports for a WKWebView in the XCTest hierarchy. */
const WEB_VIEW_CLASS = "WKWebView";

/**
 * One registered web view, in the order the app registered them, with its snapshot when it has
 * one. A web view without a snapshot still takes its place in the pairing.
 */
export interface IosSdkWebViewSnapshot {
  webViewId: string;
  snapshot?: IosSdkWebSnapshot;
}

/** The web identity a node merged from a snapshot carries, if any. */
export interface IosSdkWebTarget {
  webViewId: string;
  snapshotId: string;
  elementId: string;
}

export function iosSdkWebTarget(attributes: Record<string, unknown>): IosSdkWebTarget | null {
  const webViewId = attributes[WEB_VIEW_ID_ATTRIBUTE];
  const snapshotId = attributes[WEB_SNAPSHOT_ID_ATTRIBUTE];
  const elementId = attributes[WEB_ELEMENT_ID_ATTRIBUTE];
  if (
    typeof webViewId !== "string" ||
    typeof snapshotId !== "string" ||
    typeof elementId !== "string" ||
    !webViewId ||
    !snapshotId ||
    !elementId
  ) {
    return null;
  }
  return { webViewId, snapshotId, elementId };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxOf(value: unknown): Box | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { left, top, right, bottom } = value as Record<string, unknown>;
  if (
    typeof left !== "number" ||
    typeof top !== "number" ||
    typeof right !== "number" ||
    typeof bottom !== "number"
  ) {
    return null;
  }
  return { left, top, right, bottom };
}

function isWebView(node: ViewHierarchyNode): boolean {
  const attributes = nodeAttributes(node);
  return (attributes["class"] ?? attributes["className"]) === WEB_VIEW_CLASS;
}

/** The outermost WKWebView nodes in tree order; a web view's nested WKWebView wrappers are skipped. */
export function findWebViewNodes(hierarchy: ViewHierarchyResult | undefined): ViewHierarchyNode[] {
  const found: ViewHierarchyNode[] = [];
  const visit = (node: ViewHierarchyNode): void => {
    if (isWebView(node)) {
      found.push(node);
      return;
    }
    childrenOf(node).forEach(visit);
  };
  const root: unknown = hierarchy?.hierarchy?.node;
  const roots = Array.isArray(root)
    ? (root as ViewHierarchyNode[])
    : root && typeof root === "object"
      ? [root as ViewHierarchyNode]
      : [];
  roots.forEach(visit);
  return found;
}

/** The page's origin, as the bridge's policy compares it; undefined for a URL without one. */
function originOf(url: string | undefined): string | undefined {
  if (!url || !URL.canParse(url)) {
    return undefined;
  }
  const origin = new URL(url).origin;
  return origin === "null" ? undefined : origin;
}

/**
 * The element's screen bounds: its `[x, y, width, height]` in the page's CSS pixels, offset by the
 * web view's origin and clipped to the web view, rounded to whole points as XCTest reports them.
 */
function screenBounds(element: IosSdkWebElement, webView: Box): Box | null {
  const [x, y, width, height] = element.bounds;
  if ([x, y, width, height].some((part) => part === undefined || !Number.isFinite(part))) {
    return null;
  }
  const left = Math.round(Math.max(webView.left, webView.left + x));
  const top = Math.round(Math.max(webView.top, webView.top + y));
  const right = Math.round(Math.min(webView.right, webView.left + x + width));
  const bottom = Math.round(Math.min(webView.bottom, webView.top + y + height));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** Element ids that occur more than once in a snapshot. */
function duplicateIds(elements: readonly IosSdkWebElement[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of elements) {
    (seen.has(id) ? duplicates : seen).add(id);
  }
  return duplicates;
}

function convertElement(
  element: IosSdkWebElement,
  bounds: Box,
  webViewId: string,
  snapshotId: string,
  origin: string | undefined,
): ViewHierarchyNode {
  const role = element.role ?? "element";
  return {
    $: {
      class: role,
      role: EDITABLE_WEB_ROLES.has(role) ? "textfield" : role,
      bounds,
      enabled: String(element.enabled),
      [WEB_VIEW_ID_ATTRIBUTE]: webViewId,
      [WEB_SNAPSHOT_ID_ATTRIBUTE]: snapshotId,
      [WEB_ELEMENT_ID_ATTRIBUTE]: element.id,
      ...(origin ? { [WEB_ORIGIN_ATTRIBUTE]: origin } : {}),
      ...(element.label ? { "content-desc": element.label } : {}),
      ...(element.value ? { text: element.value } : {}),
      ...(element.enabled ? { clickable: "true" } : {}),
      ...(element.focused ? { focused: "true" } : {}),
    },
    extras: { "sdk.source": IOS_SDK_WEB_SOURCE },
  };
}

export interface IosSdkWebMergeSummary {
  /** Web views whose snapshot was attached. */
  webViews: number;
  /** DOM elements attached (visible ones inside their web view only). */
  attached: number;
  /** XCTest leaves removed as duplicates of a DOM element. */
  deduplicated: number;
}

/**
 * Attaches the snapshot's elements under its WKWebView node, in place, when the app registered
 * exactly one web view and the screen shows exactly one outermost WKWebView. Nothing ties a
 * registration to its native view: the registry orders web views by registration, not by screen
 * position, so with two or more the pairing is ambiguous and the web views stay XCTest-only.
 */
export function mergeIosSdkWebSnapshots(
  hierarchy: ViewHierarchyResult,
  snapshots: readonly IosSdkWebViewSnapshot[],
): IosSdkWebMergeSummary | null {
  const webViewNodes = findWebViewNodes(hierarchy);
  if (snapshots.length !== 1 || webViewNodes.length !== 1) {
    return null;
  }
  const summary: IosSdkWebMergeSummary = { webViews: 0, attached: 0, deduplicated: 0 };
  webViewNodes.forEach((webViewNode, index) => {
    const { webViewId, snapshot } = snapshots[index];
    const webViewBox = boxOf(nodeBounds(webViewNode));
    if (!snapshot || !webViewBox) {
      return;
    }
    const origin = originOf(snapshot.url);
    const ambiguous = duplicateIds(snapshot.elements);
    const converted = snapshot.elements.flatMap((element) => {
      // An action names its element by id; with two elements sharing one, it could act on either.
      const bounds =
        element.visible && !ambiguous.has(element.id) ? screenBounds(element, webViewBox) : null;
      return bounds ? [{ element, bounds }] : [];
    });
    if (converted.length === 0) {
      return;
    }
    const signatures = new Set<string>();
    for (const { element, bounds } of converted) {
      const key = boundsKey(bounds);
      for (const name of [element.label, element.value]) {
        if (key && name) {
          signatures.add(`${key}|${name}`);
        }
      }
    }
    summary.deduplicated += removeCoveredLeaves(webViewNode, signatures);
    const nodes = converted.map(({ element, bounds }) =>
      convertElement(element, bounds, webViewId, snapshot.snapshotId, origin),
    );
    webViewNode.node = [...childrenOf(webViewNode), ...nodes];
    summary.webViews += 1;
    summary.attached += nodes.length;
  });
  return summary.webViews > 0 ? summary : null;
}
