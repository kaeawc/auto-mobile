import { ActionableError } from "../../models/ActionableError";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { scopeHierarchyToLayer } from "../observe/hierarchyLayer";
import { ElementResolver } from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import type { OverlayAnchor, OverlaySpec } from "./overlaySpec";

/** Android's baseline density: one dp is one px at 160 dpi. */
const BASELINE_DENSITY_DPI = 160;

type ElementAnchor = Extract<OverlayAnchor, { type: "element" }>;

/** Screen-space bounds in the unit every overlay spec size uses: dp on Android, points on iOS. */
export interface OverlayDpBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element anchor as the host resolved it at show time; it does not follow later layout. */
export interface ResolvedOverlayAnchor {
  /** The anchored node's spec path, spelled as validation errors spell it (`root.children[0]`). */
  path: string;
  alignment: ElementAnchor["alignment"];
  /**
   * The app element's screen bounds as `observe` reports them: px on Android, points on iOS (the
   * field keeps its Android name).
   */
  boundsPx: ElementBounds;
  /** The same bounds in spec units: dp converted once with the capture's density, or iOS points. */
  bounds: OverlayDpBounds;
}

export interface OverlayAnchorResolution {
  /** The spec to send: every element anchor replaced by a bounds anchor in dp. */
  spec: OverlaySpec;
  anchors: ResolvedOverlayAnchor[];
  /** Device timestamp of the hierarchy the anchors were resolved against. */
  hierarchyUpdatedAt?: number;
}

/**
 * The unit of the capture's bounds. Android hierarchies are px and convert to dp with the capture's
 * density; iOS hierarchies are already points, the unit iOS spec sizes use, so they convert to
 * nothing.
 */
export type OverlayAnchorBoundsUnit = "px" | "points";

/** The capture an element anchor is resolved against. */
export interface OverlayAnchorCapture {
  hierarchy: ViewHierarchyResult;
  updatedAt?: number;
  /** Defaults to `px` (Android). */
  boundsUnit?: OverlayAnchorBoundsUnit;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

/** Node children live only in `child` and `children` (schemas/overlay-spec-contract.json). */
function childrenOf(node: Raw, path: string): { node: Raw; path: string }[] {
  const single = record(node.child);
  if (single) {
    return [{ node: single, path: `${path}.child` }];
  }
  const list = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  return list.flatMap((entry, index) => {
    const child = record(entry);
    return child ? [{ node: child, path: `${path}.children[${index}]` }] : [];
  });
}

/** The spec was validated before anchors are read, so the tag decides the variant. */
function isAnchor(value: unknown): value is OverlayAnchor {
  const type = record(value)?.type;
  return type === "bounds" || type === "element";
}

function anchoredNodes(root: Raw): { node: Raw; path: string; anchor: OverlayAnchor }[] {
  const found: { node: Raw; path: string; anchor: OverlayAnchor }[] = [];
  const pending = [{ node: root, path: "root" }];
  while (pending.length > 0) {
    const next = pending.shift()!;
    const anchor = next.node.anchor;
    if (isAnchor(anchor)) {
      found.push({ ...next, anchor });
    }
    pending.push(...childrenOf(next.node, next.path));
  }
  return found;
}

/** Whether any node of the spec carries an anchor, of either kind. */
export function hasOverlayAnchors(spec: OverlaySpec): boolean {
  const root = record(spec.root);
  return root !== undefined && anchoredNodes(root).length > 0;
}

/**
 * Converts Android px to dp with a display density in dpi (`densityDpi`, which observe reports as
 * `density`). Non-integer scales such as 373 dpi (2.33125) convert exactly as the device does.
 */
export function pxToDp(px: number, densityDpi: number): number {
  if (!Number.isFinite(densityDpi) || densityDpi <= 0) {
    throw new ActionableError(`Cannot convert px to dp: display density ${densityDpi} is invalid.`);
  }
  return (px * BASELINE_DENSITY_DPI) / densityDpi;
}

function describeSelector(selector: ElementAnchor["selector"]): string {
  return JSON.stringify(selector);
}

function onScreen(bounds: ElementBounds, hierarchy: ViewHierarchyResult): boolean {
  const width = hierarchy.screenWidth;
  const height = hierarchy.screenHeight;
  if (!width || !height) {
    return true;
  }
  return bounds.right > 0 && bounds.bottom > 0 && bounds.left < width && bounds.top < height;
}

function resolveElement(
  site: { path: string; anchor: ElementAnchor },
  hierarchy: ViewHierarchyResult,
  nodes: ReturnType<SearchableHierarchy["project"]>,
): ElementBounds {
  const { selector } = site.anchor;
  const resolution = new ElementResolver().resolve(
    { id: "overlay-anchor", nodes },
    { ...selector, selectionStrategy: "unique" },
    // Tap's own resolution: a text match is promoted to its clickable owner, like tapOn. No
    // viewport: an off-screen target is reported as off screen below, not as missing.
    { action: "highlight", requireBounds: true },
  );
  const where = `${site.path}.anchor: the app element ${describeSelector(selector)}`;
  const bounds = resolution.chosen?.element?.bounds;
  if (resolution.error || !bounds) {
    throw new ActionableError(
      `${where} could not be resolved (${resolution.error ?? "Target not found"}). Only the app is searched; the overlay is excluded. Nothing was shown. Observe the app and fix the selector.`,
    );
  }
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    throw new ActionableError(
      `${where} has empty bounds ${JSON.stringify(bounds)}. Nothing was shown. Anchor to an element that is laid out on screen.`,
    );
  }
  if (!onScreen(bounds, hierarchy)) {
    throw new ActionableError(
      `${where} is off screen at ${JSON.stringify(bounds)}. Nothing was shown. Scroll it into view, then show again.`,
    );
  }
  return bounds;
}

function dpBounds(bounds: ElementBounds, densityDpi: number): OverlayDpBounds {
  return {
    x: pxToDp(bounds.left, densityDpi),
    y: pxToDp(bounds.top, densityDpi),
    width: pxToDp(bounds.right - bounds.left, densityDpi),
    height: pxToDp(bounds.bottom - bounds.top, densityDpi),
  };
}

function pointBounds(bounds: ElementBounds): OverlayDpBounds {
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

/** Converts a capture's element bounds into spec units, refusing a px capture without a density. */
function specUnitConverter(
  capture: OverlayAnchorCapture,
): (bounds: ElementBounds) => OverlayDpBounds {
  if (capture.boundsUnit === "points") {
    return pointBounds;
  }
  const density = capture.hierarchy.density;
  if (typeof density !== "number" || !Number.isFinite(density) || density <= 0) {
    throw new ActionableError(
      "Element anchors need the display density, and the device's hierarchy did not report one. Nothing was shown. Use a bounds anchor in dp instead.",
    );
  }
  return (bounds) => dpBounds(bounds, density);
}

/**
 * A floating window is only as large as its content and moves onto its anchored root, so an anchor
 * anywhere below the root would be laid out outside the window and clipped. Fullscreen and sheet
 * windows take an anchor on any node.
 */
export function overlayAnchorPlacementError(spec: OverlaySpec): string | undefined {
  const root = record(spec.root);
  if (spec.window.placement.type !== "floating" || root === undefined) {
    return undefined;
  }
  const nested = anchoredNodes(root).find(({ path }) => path !== "root");
  return nested
    ? `${nested.path}.anchor: in a floating window only the root node can be anchored (the window moves onto it). Nothing was shown. Anchor the root, or use a fullscreen or sheet placement.`
    : undefined;
}

/** Element anchors that need a hierarchy; bounds anchors are already in dp. */
export function hasElementAnchors(spec: OverlaySpec): boolean {
  const root = record(spec.root);
  return root !== undefined && anchoredNodes(root).some(({ anchor }) => anchor.type === "element");
}

/**
 * Resolves every element anchor against the app's hierarchy (AutoMobile's own overlay windows are
 * excluded) and converts its bounds to spec units once: Android px to dp with the capture's display
 * density, iOS points unchanged. A missing, ambiguous, empty or off-screen element throws before
 * anything is shown. The returned spec is a copy in which each element anchor is a bounds anchor
 * keeping its alignment and offset; the input is not mutated, and a spec without element anchors is
 * returned as the same object.
 */
export function resolveOverlayAnchors(
  spec: OverlaySpec,
  capture: OverlayAnchorCapture,
): OverlayAnchorResolution {
  if (!hasElementAnchors(spec)) {
    return { spec, anchors: [] };
  }
  const toSpecUnits = specUnitConverter(capture);
  const app = scopeHierarchyToLayer(capture.hierarchy, "app");
  const nodes = new SearchableHierarchy().project(app);
  const copy = structuredClone(spec);
  const anchors = anchoredNodes(record(copy.root) ?? {}).flatMap(({ node, path, anchor }) => {
    if (anchor.type !== "element") {
      return [];
    }
    const boundsPx = resolveElement({ path, anchor }, app, nodes);
    const bounds = toSpecUnits(boundsPx);
    node.anchor = {
      type: "bounds",
      bounds,
      alignment: anchor.alignment,
      ...(anchor.offset ? { offset: anchor.offset } : {}),
    } satisfies OverlayAnchor;
    return [{ path, alignment: anchor.alignment, boundsPx, bounds }];
  });
  return {
    spec: copy,
    anchors,
    ...(capture.updatedAt !== undefined ? { hierarchyUpdatedAt: capture.updatedAt } : {}),
  };
}
