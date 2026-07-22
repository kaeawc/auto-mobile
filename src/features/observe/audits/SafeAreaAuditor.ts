import type { LayoutWarning, ObservationEdgeInsets, ObserveResult } from "../../../models";
import { isTruthy } from "../../../models/Element";

type Node = Record<string, unknown>;
type Side = LayoutWarning["sides"][number];

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

  private contentInsets(insets: NonNullable<ObserveResult["insets"]>): {
    edges: ObservationEdgeInsets;
    types: LayoutWarning["insetTypes"];
  } | null {
    if (insets.safeArea) {
      return { edges: insets.safeArea, types: ["safeArea"] };
    }
    const bars = insets.systemBars?.visible;
    const cutout = insets.displayCutout;
    if (!bars && !cutout) {
      return null;
    }
    return {
      edges: {
        top: Math.max(bars?.top ?? 0, cutout?.top ?? 0),
        right: Math.max(bars?.right ?? 0, cutout?.right ?? 0),
        bottom: Math.max(bars?.bottom ?? 0, cutout?.bottom ?? 0),
        left: Math.max(bars?.left ?? 0, cutout?.left ?? 0),
      },
      types: [bars ? "systemBars" : undefined, cutout ? "displayCutout" : undefined]
        .filter((type): type is "systemBars" | "displayCutout" => type !== undefined),
    };
  }

  private inspectNode(
    node: Node,
    screen: { width: number; height: number },
    content: ReturnType<SafeAreaAuditor["contentInsets"]>,
    systemGestures: ObservationEdgeInsets | undefined,
    mandatorySystemGestures: ObservationEdgeInsets | undefined,
    warnings: LayoutWarning[]
  ): void {
    if (isSystemNode(node)) {
      return;
    }
    const bounds = readBounds(node);
    const categories = categoriesFor(node);
    if (bounds && categories.length > 0 && !isScreenSized(bounds, screen) && node.enabled !== "false") {
      if (content) {
        const sides = intersectingSides(bounds, screen, content.edges);
        if (sides.length > 0) {
          warnings.push(this.warning(node, bounds, categories, content.types, sides, "important-content-under-inset", "warning", screen, content.edges));
        }
      }
      if (categories.includes("interaction")) {
        const gesture = maxInsets(systemGestures, mandatorySystemGestures);
        const sides = gesture ? intersectingSides(bounds, screen, gesture) : [];
        if (gesture && sides.length > 0) {
          const types: LayoutWarning["insetTypes"] = [
            systemGestures ? "systemGestures" : undefined,
            mandatorySystemGestures ? "mandatorySystemGestures" : undefined,
          ].filter((type): type is "systemGestures" | "mandatorySystemGestures" => type !== undefined);
          warnings.push(this.warning(node, bounds, ["interaction"], types, sides, "interaction-in-system-gesture-region", "info", screen, gesture));
        }
      }
    }
    for (const child of asNodes(node.node)) {
      this.inspectNode(child, screen, content, systemGestures, mandatorySystemGestures, warnings);
    }
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
  if (Array.isArray(value)) return value.filter(isNode);
  return isNode(value) ? [value] : [];
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object";
}

function readBounds(node: Node): ObservationEdgeInsets | null {
  const candidate = node.bounds;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (![value.left, value.top, value.right, value.bottom].every(item => typeof item === "number")) return null;
  return value as unknown as ObservationEdgeInsets;
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
  if (!a && !b) return undefined;
  return { top: Math.max(a?.top ?? 0, b?.top ?? 0), right: Math.max(a?.right ?? 0, b?.right ?? 0), bottom: Math.max(a?.bottom ?? 0, b?.bottom ?? 0), left: Math.max(a?.left ?? 0, b?.left ?? 0) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    const key = `${warning.type}:${warning.element.viewId ?? warning.element.resourceId ?? warning.element.text ?? "unknown"}:${warning.sides.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
