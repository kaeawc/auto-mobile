import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import { nodeAttributes, nodeBounds } from "../../../models/ViewHierarchyResult";
import { boundsKey, childrenOf } from "./iosSdkObservationMerge";
import type { IosSdkWebElement, IosSdkWebSnapshot, IosSdkWebViewport } from "./sdkWebViewBridge";
import { WEB_SNAPSHOT_ID_ATTRIBUTE } from "../../../utils/hierarchyFingerprint";
import { VALUE_REDACTED_ATTRIBUTE } from "../../../models/Element";

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
/** The element's DOM role (its ARIA role, else its tag), kept where a replaced leaf's class wins. */
export const WEB_ROLE_ATTRIBUTE = "web-role";

/** DOM roles whose text is their `value`: the only fields the web view's setValue and clear edit. */
const VALUE_FIELD_ROLES: ReadonlySet<string> = new Set(["input", "textarea"]);

/**
 * The web identity of a merged element whose text the web view can set and clear, or null. Other
 * editors (`contenteditable`, ARIA textboxes) ignore an assigned `value`, so they stay on XCTest.
 */
export function iosSdkWebValueTarget(attributes: Record<string, unknown>): IosSdkWebTarget | null {
  const role = attributes[WEB_ROLE_ATTRIBUTE];
  return typeof role === "string" && VALUE_FIELD_ROLES.has(role)
    ? iosSdkWebTarget(attributes)
    : null;
}

/**
 * DOM roles of text entry fields. They are reported as an XCTest text field would be (`role:
 * textfield`, focusable, with an input type), so focus, sendKeys and setUIState still treat a merged
 * field as editable after its XCTest duplicate is removed. An `<input>` counts only with a text-like
 * type (see {@link TEXT_INPUT_TYPES}).
 */
const EDITABLE_WEB_ROLES: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "textbox",
  "searchbox",
  "combobox",
]);

/**
 * `<input>` types that take typed text. A checkbox, radio, range, file or button input is not a text
 * field. An input without a reported type (an SDK that predates it) is taken as text, the HTML default.
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

function isEditable(element: IosSdkWebElement, role: string): boolean {
  if (role !== "input") {
    return EDITABLE_WEB_ROLES.has(role);
  }
  return TEXT_INPUT_TYPES.has((element.inputType ?? "text").toLowerCase());
}

/** The value the SDK bridge reports in place of a DOM value when its policy redacts text. */
const REDACTED_WEB_VALUE = "[REDACTED]";

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

/**
 * The web identity of the merged DOM element with this web view and element id in `hierarchy`,
 * carrying the snapshot id it was merged from there; null when no such element was merged.
 * Element ids are stable across a document's snapshots, so this finds the same element in a newer
 * snapshot.
 */
export function findIosSdkWebTarget(
  hierarchy: ViewHierarchyResult | undefined,
  webViewId: string,
  elementId: string,
): IosSdkWebTarget | null {
  const root: unknown = hierarchy?.hierarchy?.node;
  const pending: ViewHierarchyNode[] = Array.isArray(root)
    ? [...(root as ViewHierarchyNode[])]
    : root && typeof root === "object"
      ? [root as ViewHierarchyNode]
      : [];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const target = iosSdkWebTarget(nodeAttributes(node));
    if (target && target.webViewId === webViewId && target.elementId === elementId) {
      return target;
    }
    pending.push(...childrenOf(node));
  }
  return null;
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

/** How CSS pixels map onto the web view: an offset in CSS pixels, then points per CSS pixel. */
interface CssToPoints {
  offsetLeft: number;
  offsetTop: number;
  pointsPerPixel: number;
}

/**
 * The visual viewport fills the web view, so its CSS width spans the web view's width in points.
 * That ratio covers a page without a `device-width` viewport (a 980 px layout viewport in a 390 pt
 * web view) and pinch zoom alike. Without a usable viewport, CSS pixels are taken as points.
 */
function cssToPoints(viewport: IosSdkWebViewport | undefined, webView: Box): CssToPoints {
  const usable =
    viewport !== undefined &&
    [viewport.offsetLeft, viewport.offsetTop, viewport.width].every(Number.isFinite) &&
    viewport.width > 0;
  if (!usable) {
    return { offsetLeft: 0, offsetTop: 0, pointsPerPixel: 1 };
  }
  return {
    offsetLeft: viewport.offsetLeft,
    offsetTop: viewport.offsetTop,
    pointsPerPixel: (webView.right - webView.left) / viewport.width,
  };
}

/**
 * The element's screen bounds: its `[x, y, width, height]` in the page's CSS pixels, converted to
 * points relative to the visual viewport, offset by the web view's origin and clipped to the web
 * view, truncated to whole points as the runner reports XCTest frames (`Int(value)`), so a DOM
 * element and its XCTest twin get the same bounds.
 */
function screenBounds(element: IosSdkWebElement, webView: Box, scale: CssToPoints): Box | null {
  const [x, y, width, height] = element.bounds;
  if ([x, y, width, height].some((part) => part === undefined || !Number.isFinite(part))) {
    return null;
  }
  const originX = webView.left + (x - scale.offsetLeft) * scale.pointsPerPixel;
  const originY = webView.top + (y - scale.offsetTop) * scale.pointsPerPixel;
  const left = Math.trunc(Math.max(webView.left, originX));
  const top = Math.trunc(Math.max(webView.top, originY));
  const right = Math.trunc(Math.min(webView.right, originX + width * scale.pointsPerPixel));
  const bottom = Math.trunc(Math.min(webView.bottom, originY + height * scale.pointsPerPixel));
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

/**
 * The element's value as text. A redacted value is not the page's text, so it is reported as
 * present but unreadable, unless a replaced XCTest leaf reports a readable `value` of its own.
 */
function valueAttributes(
  element: IosSdkWebElement,
  native: Record<string, unknown> | undefined,
): Record<string, string> {
  if (element.value !== REDACTED_WEB_VALUE) {
    return element.value ? { text: element.value } : {};
  }
  return typeof native?.value === "string" ? {} : { [VALUE_REDACTED_ATTRIBUTE]: "true" };
}

function convertElement(
  element: IosSdkWebElement,
  bounds: Box,
  webViewId: string,
  snapshotId: string,
  origin: string | undefined,
  native?: Record<string, unknown>,
): ViewHierarchyNode {
  const role = element.role ?? "element";
  const editable = isEditable(element, role);
  return {
    $: {
      class: role,
      role: editable ? "textfield" : role,
      // The input properties the shared field detectors read, as a native text field reports them.
      ...(editable ? { focusable: "true", "input-type": "text" } : {}),
      enabled: String(element.enabled),
      ...(element.label ? { "content-desc": element.label } : {}),
      ...valueAttributes(element, native),
      ...(element.enabled ? { clickable: "true" } : {}),
      // The snapshot's focus can be older than the fresh XCTest read, which reports focus by
      // omission, so a replaced leaf's focus is the leaf's alone.
      ...(element.focused && !native ? { focused: "true" } : {}),
      // A replaced XCTest leaf's attributes are fresh and are what native selectors, field
      // detection and verification read, so each one wins over the snapshot's.
      ...native,
      bounds,
      [WEB_VIEW_ID_ATTRIBUTE]: webViewId,
      [WEB_SNAPSHOT_ID_ATTRIBUTE]: snapshotId,
      [WEB_ELEMENT_ID_ATTRIBUTE]: element.id,
      [WEB_ROLE_ATTRIBUTE]: role,
      ...(origin ? { [WEB_ORIGIN_ATTRIBUTE]: origin } : {}),
    },
    extras: { "sdk.source": IOS_SDK_WEB_SOURCE },
  };
}

/** Bounds plus the label or value a DOM element shows: what an XCTest duplicate would also show. */
function signaturesOf(element: IosSdkWebElement, bounds: Box): string[] {
  const key = boundsKey(bounds);
  return key
    ? [element.label, element.value].flatMap((name) => (name ? [`${key}|${name}`] : []))
    : [];
}

/**
 * Replaces each XCTest leaf a DOM element covers (same bounds and the same label, text or id) with
 * that element, in the leaf's place, so container-scoped selectors still find it. The leaf's own
 * attributes all win (its class, `resource-id`, input and toggle properties, focus and the rest):
 * the element adds only its web identity and what the leaf does not report.
 * A second leaf covered by an element already placed is removed as a duplicate.
 */
function replaceCoveredLeaves(
  node: ViewHierarchyNode,
  covering: ReadonlyMap<string, number>,
  build: (position: number, native: Record<string, unknown>) => ViewHierarchyNode,
  placed: Set<number>,
): number {
  const children = childrenOf(node);
  if (children.length === 0) {
    return 0;
  }
  let replaced = 0;
  const next = children.flatMap((child): ViewHierarchyNode[] => {
    const position = childrenOf(child).length === 0 ? coveringElement(child, covering) : undefined;
    if (position === undefined) {
      replaced += replaceCoveredLeaves(child, covering, build, placed);
      return [child];
    }
    replaced += 1;
    if (placed.has(position)) {
      return [];
    }
    placed.add(position);
    // The DOM element's own bounds replace the leaf's.
    const native = Object.fromEntries(
      Object.entries(nodeAttributes(child)).filter(([name]) => name !== "bounds"),
    );
    return [build(position, native)];
  });
  node.node = next;
  return replaced;
}

function coveringElement(
  leaf: ViewHierarchyNode,
  covering: ReadonlyMap<string, number>,
): number | undefined {
  const key = boundsKey(nodeBounds(leaf));
  if (!key) {
    return undefined;
  }
  const attributes = nodeAttributes(leaf);
  const positions = new Set(
    ["resource-id", "content-desc", "text"].flatMap((name) => {
      const value = attributes[name];
      const position =
        typeof value === "string" && value ? covering.get(`${key}|${value}`) : undefined;
      return position === undefined ? [] : [position];
    }),
  );
  // A leaf whose attributes match different DOM elements could be either one, so it is not replaced.
  return positions.size === 1 ? [...positions][0] : undefined;
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
    const scale = cssToPoints(snapshot.viewport, webViewBox);
    const converted = snapshot.elements.flatMap((element) => {
      // An action names its element by id: with none it cannot be routed, and with two elements
      // sharing one it could act on either.
      const routable = element.id !== "" && !ambiguous.has(element.id);
      const bounds = element.visible && routable ? screenBounds(element, webViewBox, scale) : null;
      return bounds ? [{ element, bounds }] : [];
    });
    if (converted.length === 0) {
      return;
    }
    // A signature two elements share (a wrapper and the control it wraps, say) cannot tell which
    // one a native leaf is, so it matches no leaf: replacing it would give the leaf's id to either.
    const covering = new Map<string, number>();
    const shared = new Set<string>();
    converted.forEach(({ element, bounds }, position) => {
      for (const signature of new Set(signaturesOf(element, bounds))) {
        if (covering.has(signature)) {
          shared.add(signature);
        } else {
          covering.set(signature, position);
        }
      }
    });
    shared.forEach((signature) => covering.delete(signature));
    const build = (position: number, native?: Record<string, unknown>) => {
      const { element, bounds } = converted[position];
      return convertElement(element, bounds, webViewId, snapshot.snapshotId, origin, native);
    };
    const placed = new Set<number>();
    summary.deduplicated += replaceCoveredLeaves(webViewNode, covering, build, placed);
    const appended = converted.flatMap((_, position) =>
      placed.has(position) ? [] : [build(position)],
    );
    webViewNode.node = [...childrenOf(webViewNode), ...appended];
    summary.webViews += 1;
    summary.attached += converted.length;
  });
  return summary.webViews > 0 ? summary : null;
}
