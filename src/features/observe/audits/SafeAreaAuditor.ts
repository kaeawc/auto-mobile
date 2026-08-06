import type { LayoutWarning, LayoutWarnings, ObservationEdgeInsets, ObserveResult } from "../../../models";
import { isTruthy } from "../../../models/Element";

type Node = Record<string, unknown>;
type Side = LayoutWarning["sides"][number];
type ContentInsets = {
  edges: ObservationEdgeInsets;
  typesForSides: (sides: Side[]) => LayoutWarning["insetTypes"];
};
type WarningCandidate = {
  warning: LayoutWarning;
  node: Node;
  ancestors: Node[];
};

/**
 * Upper bound on emitted `layoutWarnings.warnings`. The audit now runs on every
 * observation, so an unbounded array would bloat every result — and, under
 * `--actions-diff-observe`, the scalar diff that copies both the before and
 * after arrays into `{from, to}`. Real screens self-limit to a handful (only
 * nodes physically inside the thin inset strips are flagged), so this cap only
 * ever trims pathological inputs; when it does, the truncation is surfaced via
 * `scope: "truncated"` + `total` rather than dropped silently.
 */
export const MAX_LAYOUT_WARNINGS = 100;

/**
 * Wrap the advisory list in the `LayoutWarnings` envelope, capping at
 * {@link MAX_LAYOUT_WARNINGS}. At or under the cap the original array is kept
 * unchanged (identical order) with `scope: "full"`; over it, the
 * highest-severity, largest-overflow warnings are kept and `scope: "truncated"`
 * carries the pre-cap `total`.
 */
export function capLayoutWarnings(warnings: LayoutWarning[]): LayoutWarnings {
  if (warnings.length <= MAX_LAYOUT_WARNINGS) {
    return { scope: "full", warnings };
  }
  const kept = [...warnings]
    .sort((a, b) => layoutWarningPriority(b) - layoutWarningPriority(a))
    .slice(0, MAX_LAYOUT_WARNINGS);
  return { scope: "truncated", total: warnings.length, warnings: kept };
}

/** Higher = kept first when capping: `warning` severity outranks `info`, then larger total overflow. */
function layoutWarningPriority(warning: LayoutWarning): number {
  const severityRank = warning.severity === "warning" ? 1_000_000 : 0;
  let overflow = 0;
  for (const value of Object.values(warning.overflowPx ?? {})) {
    overflow += value ?? 0;
  }
  return severityRank + overflow;
}

/**
 * Report-only edge-to-edge inspection. It intentionally warns about potential
 * important-content overlap rather than declaring a screen non-compliant:
 * backgrounds and scrolling content are often meant to draw edge-to-edge.
 */
export class SafeAreaAuditor {
  /**
   * Per-`inspect` memo for {@link SafeAreaAuditor.hasOverlappingContentDescendant},
   * keyed by raw-node identity. Reset at the start of every `inspect` so it never
   * carries across calls.
   */
  private contentOverlapMemo = new WeakMap<Node, boolean>();

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
    const foregroundPackage = result.activeWindow?.appId ?? result.viewHierarchy.packageName;
    const warnings: WarningCandidate[] = [];
    this.contentOverlapMemo = new WeakMap();
    for (const root of asNodes(result.viewHierarchy.hierarchy.node)) {
      this.inspectNode(root, screen, contentInsets, insets.systemGestures, insets.mandatorySystemGestures, foregroundPackage, [], warnings);
    }
    return dedupeWarnings(warnings);
  }

  private contentInsets(insets: NonNullable<ObserveResult["insets"]>): ContentInsets | null {
    if (insets.safeArea) {
      return {
        edges: insets.safeArea,
        typesForSides: sides => hasInsetOnSides(insets.safeArea, sides) ? ["safeArea"] : [],
      };
    }
    const bars = insets.systemBars?.visible;
    const cutout = insets.displayCutout;
    const edges = maxInsets(bars, cutout);
    if (!edges) {return null;}
    return {
      edges,
      typesForSides: sides => insetTypes(bars, cutout, "systemBars", "displayCutout", sides),
    };
  }

  private inspectNode(
    node: Node,
    screen: { width: number; height: number },
    content: ContentInsets | null,
    systemGestures: ObservationEdgeInsets | undefined,
    mandatorySystemGestures: ObservationEdgeInsets | undefined,
    foregroundPackage: string | undefined,
    ancestors: Node[],
    warnings: WarningCandidate[]
  ): void {
    const inspectedNode = withHierarchyAttributes(node);
    if (!isForeignNode(inspectedNode, foregroundPackage)) {
      this.inspectElement(
        inspectedNode,
        node,
        ancestors,
        screen,
        content,
        systemGestures,
        mandatorySystemGestures,
        foregroundPackage,
        warnings
      );
    }
    // `ancestors` is a mutable stack shared across the traversal: push self, recurse,
    // pop. A warning candidate snapshots it (`[...ancestors]`) at creation, so only
    // the few warning sites pay the copy — not every node, which would be O(n·depth).
    ancestors.push(node);
    for (const child of asNodes(node.node)) {
      this.inspectNode(child, screen, content, systemGestures, mandatorySystemGestures, foregroundPackage, ancestors, warnings);
    }
    ancestors.pop();
  }

  private inspectElement(
    node: Node,
    sourceNode: Node,
    ancestors: Node[],
    screen: { width: number; height: number },
    content: ContentInsets | null,
    systemGestures: ObservationEdgeInsets | undefined,
    mandatorySystemGestures: ObservationEdgeInsets | undefined,
    foregroundPackage: string | undefined,
    warnings: WarningCandidate[]
  ): void {
    const bounds = readBounds(node);
    const categories = categoriesFor(node);
    if (!bounds || categories.length === 0 || !isOnScreen(bounds, screen) || isScreenSized(bounds, screen) || node.enabled === "false") {return;}
    this.inspectContent(node, sourceNode, ancestors, bounds, categories, screen, content, foregroundPackage, warnings);
    this.inspectGestureRegion(node, sourceNode, ancestors, bounds, categories, screen, systemGestures, mandatorySystemGestures, warnings);
  }

  private inspectContent(
    node: Node,
    sourceNode: Node,
    ancestors: Node[],
    bounds: ObservationEdgeInsets,
    categories: LayoutWarning["categories"],
    screen: { width: number; height: number },
    content: ContentInsets | null,
    foregroundPackage: string | undefined,
    warnings: WarningCandidate[]
  ): void {
    if (!content) {return;}
    const sides = intersectingSides(bounds, screen, content.edges)
      .filter(side => content.typesForSides([side]).length > 0);
    if (sides.length === 0) {return;}
    warnings.push({
      warning: this.warning(
        node,
        bounds,
        categories,
        content.typesForSides(sides),
        sides,
        "important-content-under-inset",
        this.contentSeverity(sourceNode, bounds, screen, content.edges, foregroundPackage),
        screen,
        content.edges
      ),
      node: sourceNode,
      ancestors: [...ancestors],
    });
  }

  private contentSeverity(
    node: Node,
    bounds: ObservationEdgeInsets,
    screen: { width: number; height: number },
    insets: ObservationEdgeInsets,
    foregroundPackage: string | undefined
  ): LayoutWarning["severity"] {
    const overlap = overlapPercent(bounds, screen, insets);
    if (isLargeContainer(node, bounds, screen) && !this.hasOverlappingContentDescendant(node, screen, insets, foregroundPackage)) {
      return "info";
    }
    return overlap >= 50 ? "warning" : "info";
  }

  /**
   * Whether any content-bearing descendant of `node` overlaps a content inset.
   * Memoized per `inspect` call by raw-node identity ({@link contentOverlapMemo}):
   * `screen`, `insets` (the `content.edges`), and `foregroundPackage` are constant
   * within a call, so a node's answer is stable. Without the memo, a chain of
   * nested large containers rescans overlapping subtrees — O(n^2) on deep trees;
   * the memo makes it a single pass. Behavior matches the prior recursive walk:
   * each strict descendant is attribute-merged before the overlap test, and the
   * `node` argument itself is never tested.
   */
  private hasOverlappingContentDescendant(
    node: Node,
    screen: { width: number; height: number },
    insets: ObservationEdgeInsets,
    foregroundPackage: string | undefined
  ): boolean {
    const cached = this.contentOverlapMemo.get(node);
    if (cached !== undefined) {
      return cached;
    }
    const result = asNodes(node.node).some(child => {
      const inspectedChild = withHierarchyAttributes(child);
      return overlapsContentInset(inspectedChild, screen, insets, foregroundPackage)
        || this.hasOverlappingContentDescendant(child, screen, insets, foregroundPackage);
    });
    this.contentOverlapMemo.set(node, result);
    return result;
  }

  private inspectGestureRegion(node: Node, sourceNode: Node, ancestors: Node[], bounds: ObservationEdgeInsets, categories: LayoutWarning["categories"], screen: { width: number; height: number }, systemGestures: ObservationEdgeInsets | undefined, mandatorySystemGestures: ObservationEdgeInsets | undefined, warnings: WarningCandidate[]): void {
    if (!categories.includes("interaction")) {return;}
    const gesture = maxInsets(systemGestures, mandatorySystemGestures);
    if (!gesture) {return;}
    const sides = intersectingSides(bounds, screen, gesture);
    if (sides.length > 0) {
      warnings.push({
        warning: this.warning(node, bounds, ["interaction"], insetTypes(systemGestures, mandatorySystemGestures, "systemGestures", "mandatorySystemGestures", sides), sides, "interaction-in-system-gesture-region", "info", screen, gesture),
        node: sourceNode,
        ancestors: [...ancestors],
      });
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
      overflowPx: overflowPx(bounds, screen, insets, sides),
      insetPx: sideValues(insets, sides),
      overlapPercent: overlapPercent(bounds, screen, insets),
      confidence: node.occlusionState === "partial" ? "high" : "medium",
    };
  }
}

function asNodes(value: unknown): Node[] {
  if (Array.isArray(value)) {return value.filter(isNode);}
  return isNode(value) ? [value] : [];
}

/** iOS CtrlProxy stores hierarchy attributes in xml2js-style `$` bags. */
function withHierarchyAttributes(node: Node): Node {
  const attributes = node.$;
  return isNode(attributes) && !Array.isArray(attributes) ? { ...node, ...attributes } : node;
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
    || (Array.isArray(node.actions) && node.actions.length > 0)
    || hasSdkInteraction(node.extras);
  return [text ? "text" : undefined, interaction ? "interaction" : undefined]
    .filter((category): category is "text" | "interaction" => category !== undefined);
}

function hasSdkInteraction(value: unknown): boolean {
  if (!isNode(value)) {return false;}
  return isTruthy(value["sdk.hasTapTarget"] as boolean | string | undefined)
    || stringValue(value["sdk.accessibilityCustomActions"]) !== undefined;
}

function isForeignNode(node: Node, foregroundPackage: string | undefined): boolean {
  const resourceId = stringValue(node["resource-id"]);
  const nodePackage = stringValue(node.packageName);
  const resourcePackage = resourceIdPackage(resourceId);
  if (foregroundPackage && (
    (nodePackage !== undefined && nodePackage !== foregroundPackage)
    || (resourcePackage?.includes(".") && resourcePackage !== foregroundPackage)
    || resourceId?.startsWith("android:id/input_method_")
  )) {
    return true;
  }
  const id = `${resourceId ?? ""} ${nodePackage ?? ""}`;
  return id.includes("com.android.systemui") || id.includes("com.apple.springboard");
}

function resourceIdPackage(resourceId: string | undefined): string | undefined {
  if (!resourceId) {return undefined;}
  const separator = resourceId.indexOf(":");
  return separator > 0 ? resourceId.slice(0, separator) : undefined;
}

function isScreenSized(bounds: ObservationEdgeInsets, screen: { width: number; height: number }): boolean {
  return bounds.left === 0 && bounds.top === 0 && bounds.right === screen.width && bounds.bottom === screen.height;
}

function isOnScreen(bounds: ObservationEdgeInsets, screen: { width: number; height: number }): boolean {
  return bounds.right > 0 && bounds.bottom > 0 && bounds.left < screen.width && bounds.top < screen.height;
}

function isLargeContainer(node: Node, bounds: ObservationEdgeInsets, screen: { width: number; height: number }): boolean {
  return asNodes(node.node).length > 0
    && bounds.right - bounds.left >= screen.width * 0.9
    && (bounds.right - bounds.left) * (bounds.bottom - bounds.top) >= screen.width * screen.height * 0.2;
}

/** A node whose content (text/interaction) overlaps a content inset side. */
function overlapsContentInset(
  node: Node,
  screen: { width: number; height: number },
  insets: ObservationEdgeInsets,
  foregroundPackage: string | undefined
): boolean {
  if (isForeignNode(node, foregroundPackage) || categoriesFor(node).length === 0) {return false;}
  const bounds = readBounds(node);
  return bounds !== null && intersectingSides(bounds, screen, insets).length > 0;
}

function intersectingSides(bounds: ObservationEdgeInsets, screen: { width: number; height: number }, insets: ObservationEdgeInsets): Side[] {
  return [
    bounds.top < insets.top ? "top" : undefined,
    bounds.right > screen.width - insets.right ? "right" : undefined,
    bounds.bottom > screen.height - insets.bottom ? "bottom" : undefined,
    bounds.left < insets.left ? "left" : undefined,
  ].filter((side): side is Side => side !== undefined);
}

function overflowPx(
  bounds: ObservationEdgeInsets,
  screen: { width: number; height: number },
  insets: ObservationEdgeInsets,
  sides: Side[]
): LayoutWarning["overflowPx"] {
  const values: Record<Side, number> = {
    top: Math.max(0, insets.top - bounds.top),
    right: Math.max(0, bounds.right - (screen.width - insets.right)),
    bottom: Math.max(0, bounds.bottom - (screen.height - insets.bottom)),
    left: Math.max(0, insets.left - bounds.left),
  };
  return sideValues(values, sides);
}

function sideValues(insets: ObservationEdgeInsets, sides: Side[]): LayoutWarning["insetPx"] {
  return Object.fromEntries(sides.map(side => [side, insets[side]]));
}

function overlapPercent(bounds: ObservationEdgeInsets, screen: { width: number; height: number }, insets: ObservationEdgeInsets): number {
  const area = Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top));
  const overlap = unionArea([
    intersectBounds(bounds, { left: 0, top: 0, right: screen.width, bottom: insets.top }),
    intersectBounds(bounds, { left: 0, top: screen.height - insets.bottom, right: screen.width, bottom: screen.height }),
    intersectBounds(bounds, { left: 0, top: 0, right: insets.left, bottom: screen.height }),
    intersectBounds(bounds, { left: screen.width - insets.right, top: 0, right: screen.width, bottom: screen.height }),
  ].filter((region): region is ObservationEdgeInsets => region !== null));
  return Math.min(100, Math.round((overlap / area) * 100));
}

function intersectBounds(a: ObservationEdgeInsets, b: ObservationEdgeInsets): ObservationEdgeInsets | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return left < right && top < bottom ? { left, top, right, bottom } : null;
}

function unionArea(regions: ObservationEdgeInsets[]): number {
  const xEdges = [...new Set(regions.flatMap(region => [region.left, region.right]))].sort((a, b) => a - b);
  const yEdges = [...new Set(regions.flatMap(region => [region.top, region.bottom]))].sort((a, b) => a - b);
  let area = 0;

  for (let x = 0; x < xEdges.length - 1; x += 1) {
    for (let y = 0; y < yEdges.length - 1; y += 1) {
      const left = xEdges[x]!;
      const top = yEdges[y]!;
      const right = xEdges[x + 1]!;
      const bottom = yEdges[y + 1]!;
      if (regions.some(region => region.left <= left && region.top <= top && region.right >= right && region.bottom >= bottom)) {
        area += (right - left) * (bottom - top);
      }
    }
  }
  return area;
}

function maxInsets(
  a?: ObservationEdgeInsets | null,
  b?: ObservationEdgeInsets | null
): ObservationEdgeInsets | undefined {
  if (!a && !b) {return undefined;}
  const insets = [a, b].filter(
    (inset): inset is ObservationEdgeInsets => inset !== undefined && inset !== null
  );
  return { top: maximumInset(insets, "top"), right: maximumInset(insets, "right"), bottom: maximumInset(insets, "bottom"), left: maximumInset(insets, "left") };
}

function maximumInset(insets: ObservationEdgeInsets[], side: keyof ObservationEdgeInsets): number {
  return Math.max(0, ...insets.map(inset => inset[side]));
}

function insetTypes<A extends LayoutWarning["insetTypes"][number], B extends LayoutWarning["insetTypes"][number]>(first: ObservationEdgeInsets | undefined | null, second: ObservationEdgeInsets | undefined | null, firstType: A, secondType: B, sides: Side[]): Array<A | B> {
  return [
    ...(hasInsetOnSides(first, sides) ? [firstType] : []),
    ...(hasInsetOnSides(second, sides) ? [secondType] : []),
  ];
}

function hasInsetOnSides(insets: ObservationEdgeInsets | undefined | null, sides: Side[]): boolean {
  return insets !== undefined && insets !== null && sides.some(side => insets[side] > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dedupeWarnings(candidates: WarningCandidate[]): LayoutWarning[] {
  const candidatesByNode = new Map<Node, WarningCandidate[]>();
  for (const candidate of candidates) {
    const nodeCandidates = candidatesByNode.get(candidate.node) ?? [];
    nodeCandidates.push(candidate);
    candidatesByNode.set(candidate.node, nodeCandidates);
  }

  const containerWarnings = new Set<WarningCandidate>();
  for (const descendant of candidates) {
    const ancestors = descendant.ancestors.flatMap(ancestorNode => candidatesByNode.get(ancestorNode) ?? []);
    for (const ancestor of ancestors) {
      if (
        ancestor.warning.type === descendant.warning.type
        && coversSides(ancestor.warning.sides, descendant.warning.sides)
        && contains(ancestor.warning.element.bounds, descendant.warning.element.bounds)
      ) {
        containerWarnings.add(ancestor);
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter(candidate => !containerWarnings.has(candidate)).filter(({ warning }) => {
    const key = `${warning.type}:${warning.element.viewId ?? warning.element.resourceId ?? warning.element.text ?? "unknown"}:${warning.sides.join(",")}`;
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  }).map(candidate => candidate.warning);
}

function coversSides(required: Side[], candidate: Side[]): boolean {
  return required.every(side => candidate.includes(side));
}

function contains(container: ObservationEdgeInsets, contained: ObservationEdgeInsets): boolean {
  return container.left <= contained.left
    && container.top <= contained.top
    && container.right >= contained.right
    && container.bottom >= contained.bottom;
}
