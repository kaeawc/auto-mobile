import type { LayoutWarning, ObservationEdgeInsets, ObserveResult } from "../../../models";
import { isTruthy } from "../../../models/Element";

type Node = Record<string, unknown>;
type Side = LayoutWarning["sides"][number];
type ContentInsets = { edges: ObservationEdgeInsets; types: LayoutWarning["insetTypes"] };

/**
 * Report-only edge-to-edge inspection. It intentionally warns about potential
 * important-content overlap rather than declaring a screen non-compliant:
 * backgrounds and scrolling content are often meant to draw edge-to-edge.
 */
export class SafeAreaAuditor {
  inspect(result: ObserveResult): LayoutWarning[] {
    const insets = result.insets;
    if (!insets?.available || !result.viewHierarchy?.hierarchy?.node) {
      return [];
    }

    const screen = result.screenSize;
    if (screen.width <= 0 || screen.height <= 0) {
      return [];
    }

    const contentInsets = this.contentInsets(insets);
    const warnings: LayoutWarning[] = [];
    for (const root of asNodes(result.viewHierarchy.hierarchy.node)) {
      this.inspectNode(root, screen, contentInsets, insets.systemGestures, insets.mandatorySystemGestures, warnings);
    }
    return dedupeWarnings(warnings);
  }

  private contentInsets(insets: NonNullable<ObserveResult["insets"]>): ContentInsets | null {
    if (insets.safeArea) {
      return { edges: insets.safeArea, types: ["safeArea"] };
    }
    const bars = insets.systemBars?.visible;
    const cutout = insets.displayCutout;
    const edges = maxInsets(bars, cutout);
    if (!edges) {return null;}
    return {
      edges,
      types: insetTypes(bars, cutout, "systemBars", "displayCutout"),
    };
  }

  private inspectNode(
    node: Node,
    screen: { width: number; height: number },
    content: ContentInsets | null,
    systemGestures: ObservationEdgeInsets | undefined,
    mandatorySystemGestures: ObservationEdgeInsets | undefined,
    warnings: LayoutWarning[]
  ): void {
    if (!isSystemNode(node)) {this.inspectElement(node, screen, content, systemGestures, mandatorySystemGestures, warnings);}
    for (const child of asNodes(node.node)) {
      this.inspectNode(child, screen, content, systemGestures, mandatorySystemGestures, warnings);
    }
  }

  private inspectElement(
    node: Node,
    screen: { width: number; height: number },
    content: ContentInsets | null,
    systemGestures: ObservationEdgeInsets | undefined,
    mandatorySystemGestures: ObservationEdgeInsets | undefined,
    warnings: LayoutWarning[]
  ): void {
    const bounds = readBounds(node);
    const categories = categoriesFor(node);
    if (!bounds || categories.length === 0 || isScreenSized(bounds, screen) || node.enabled === "false") {return;}
    this.inspectContent(node, bounds, categories, screen, content, warnings);
    this.inspectGestureRegion(node, bounds, categories, screen, systemGestures, mandatorySystemGestures, warnings);
  }

  private inspectContent(node: Node, bounds: ObservationEdgeInsets, categories: LayoutWarning["categories"], screen: { width: number; height: number }, content: ContentInsets | null, warnings: LayoutWarning[]): void {
    if (!content) {return;}
    const sides = intersectingSides(bounds, screen, content.edges);
    if (sides.length > 0) {warnings.push(this.warning(node, bounds, categories, content.types, sides, "important-content-under-inset", "warning", screen, content.edges));}
  }

  private inspectGestureRegion(node: Node, bounds: ObservationEdgeInsets, categories: LayoutWarning["categories"], screen: { width: number; height: number }, systemGestures: ObservationEdgeInsets | undefined, mandatorySystemGestures: ObservationEdgeInsets | undefined, warnings: LayoutWarning[]): void {
    if (!categories.includes("interaction")) {return;}
    const gesture = maxInsets(systemGestures, mandatorySystemGestures);
    if (!gesture) {return;}
    const sides = intersectingSides(bounds, screen, gesture);
    if (sides.length > 0) {warnings.push(this.warning(node, bounds, ["interaction"], insetTypes(systemGestures, mandatorySystemGestures, "systemGestures", "mandatorySystemGestures"), sides, "interaction-in-system-gesture-region", "info", screen, gesture));}
  }

  private warning(
    node: Node,
    bounds: ObservationEdgeInsets,
    categories: LayoutWarning["categories"],
    insetTypes: LayoutWarning["insetTypes"],
    sides: Side[],
    type: LayoutWarning["type"],
    severity: LayoutWarning["severity"],
    screen: { width: number; height: number },
    insets: ObservationEdgeInsets
  ): LayoutWarning {
    return {
      type,
      severity,
      element: {
        viewId: stringValue(node["view-id"]),
        resourceId: stringValue(node["resource-id"]),
        text: stringValue(node.text),
        contentDesc: stringValue(node["content-desc"]),
        bounds,
      },
      categories,
      insetTypes,
      sides,
      overlapPercent: overlapPercent(bounds, screen, insets),
      confidence: node.occlusionState === "partial" ? "high" : "medium",
    };
  }
}

function asNodes(value: unknown): Node[] {
  if (Array.isArray(value)) {return value.filter(isNode);}
  return isNode(value) ? [value] : [];
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object";
}

function readBounds(node: Node): ObservationEdgeInsets | null {
  const candidate = node.bounds;
  return isInsets(candidate) ? candidate : null;
}

function isInsets(value: unknown): value is ObservationEdgeInsets {
  if (!value || typeof value !== "object" || Array.isArray(value)) {return false;}
  const candidate = value as Record<string, unknown>;
  return [candidate.left, candidate.top, candidate.right, candidate.bottom].every(item => typeof item === "number");
}

function categoriesFor(node: Node): LayoutWarning["categories"] {
  const text = stringValue(node.text);
  const interaction = isTruthy(node.clickable as boolean | string | undefined)
    || isTruthy(node["long-clickable"] as boolean | string | undefined)
    || isTruthy(node.checkable as boolean | string | undefined)
    || (Array.isArray(node.actions) && node.actions.length > 0);
  return [text ? "text" : undefined, interaction ? "interaction" : undefined]
    .filter((category): category is "text" | "interaction" => category !== undefined);
}

function isSystemNode(node: Node): boolean {
  const id = `${stringValue(node["resource-id"]) ?? ""} ${stringValue(node.packageName) ?? ""}`;
  return id.includes("com.android.systemui") || id.includes("com.apple.springboard");
}

function isScreenSized(bounds: ObservationEdgeInsets, screen: { width: number; height: number }): boolean {
  return bounds.left === 0 && bounds.top === 0 && bounds.right === screen.width && bounds.bottom === screen.height;
}

function intersectingSides(bounds: ObservationEdgeInsets, screen: { width: number; height: number }, insets: ObservationEdgeInsets): Side[] {
  return [
    bounds.top < insets.top ? "top" : undefined,
    bounds.right > screen.width - insets.right ? "right" : undefined,
    bounds.bottom > screen.height - insets.bottom ? "bottom" : undefined,
    bounds.left < insets.left ? "left" : undefined,
  ].filter((side): side is Side => side !== undefined);
}

function overlapPercent(bounds: ObservationEdgeInsets, screen: { width: number; height: number }, insets: ObservationEdgeInsets): number {
  const area = Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top));
  const overlap = [
    intersectArea(bounds, { left: 0, top: 0, right: screen.width, bottom: insets.top }),
    intersectArea(bounds, { left: 0, top: screen.height - insets.bottom, right: screen.width, bottom: screen.height }),
    intersectArea(bounds, { left: 0, top: 0, right: insets.left, bottom: screen.height }),
    intersectArea(bounds, { left: screen.width - insets.right, top: 0, right: screen.width, bottom: screen.height }),
  ].reduce((total, current) => total + current, 0);
  return Math.min(100, Math.round((overlap / area) * 100));
}

function intersectArea(a: ObservationEdgeInsets, b: ObservationEdgeInsets): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function maxInsets(a?: ObservationEdgeInsets, b?: ObservationEdgeInsets): ObservationEdgeInsets | undefined {
  if (!a && !b) {return undefined;}
  const insets = [a, b].filter((inset): inset is ObservationEdgeInsets => inset !== undefined);
  return { top: maximumInset(insets, "top"), right: maximumInset(insets, "right"), bottom: maximumInset(insets, "bottom"), left: maximumInset(insets, "left") };
}

function maximumInset(insets: ObservationEdgeInsets[], side: keyof ObservationEdgeInsets): number {
  return Math.max(0, ...insets.map(inset => inset[side]));
}

function insetTypes<A extends LayoutWarning["insetTypes"][number], B extends LayoutWarning["insetTypes"][number]>(first: ObservationEdgeInsets | undefined, second: ObservationEdgeInsets | undefined, firstType: A, secondType: B): Array<A | B> {
  return [...(first ? [firstType] : []), ...(second ? [secondType] : [])];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    const key = `${warning.type}:${warning.element.viewId ?? warning.element.resourceId ?? warning.element.text ?? "unknown"}:${warning.sides.join(",")}`;
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });
}
