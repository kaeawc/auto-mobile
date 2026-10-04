import {
  STABLE_VIEW_ID_PREFIX,
  STABLE_VIEW_ID_HASH_LENGTH,
  STABLE_VIEW_ID_TEXT_HASH_LENGTH,
} from "../observe/android/StableNodeIdentity";

import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import type { SearchableEntry } from "./SearchableNode";
import { normalizeQuotes } from "./TextMatcher";
import { boundsArea, boundsEqual } from "../../utils/bounds";
import type { ElementBounds } from "../../models/ElementBounds";
import { defaultRandom } from "../../utils/Random";
import { isEditableElementProperties } from "./elementProperties";
import type { Element } from "../../models/Element";
import { compareSelectionRank } from "./selectionRank";
import { isElementCenterOffScreen } from "./ElementGeometry";

const ordinalNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}-\\d+$`,
);
const syntheticNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}(?:-\\d+|~[0-9a-f]{${STABLE_VIEW_ID_TEXT_HASH_LENGTH}})?$`,
);

// Keep label promotion within a parent or grandparent, away from distant editable ancestors.
const FOCUS_LABEL_ANCESTOR_HOP_LIMIT = 2;

export type MatchMode = "exact" | "contains" | "regex";
export type ResolutionAction =
  | "inspect"
  | "tap"
  | "long-press"
  | "scroll"
  | "input"
  | "focus-input"
  | "accessibility-focus"
  | "focus"
  | "highlight"
  | "drag";

function usesClickablePromotion(action: ResolutionAction): boolean {
  return action === "tap" || action === "long-press" || action === "highlight";
}
export interface ResolverSnapshot {
  id: string;
  nodes: readonly SearchableEntry[];
}
export interface ElementReference {
  snapshotId: string;
  nodeKey: string;
  bounds?: ElementBounds;
  label?: string;
  nativeId?: string;
}
export interface ResolutionIntent {
  action: ResolutionAction;
  /** Preserve tap ranking while inspect keeps bounded inert labels addressable. */
  preferTap?: boolean;
  /** Prefer bounded checkable matches and their checkable descendants. */
  preferToggle?: boolean;
  /** An action lookup cannot use an unbounded ID match as its target. */
  requireBounds?: boolean;
  viewport?: { width: number; height: number };
  requireResourceId?: boolean;
  negative?: boolean;
  /** Action targets may use Android editable hints only after primary text misses. */
  allowHintFallback?: boolean;
  matchMode?: MatchMode;
  ref?: ElementReference;
}
export type MatchKind =
  | "native-id-exact"
  | "node-key-exact"
  | "id-namespace"
  | "text-exact"
  | "test-tag-exact"
  | "contains"
  | "regex"
  | "class-exact"
  | "all";
export interface ElementResolution {
  chosen: SearchableEntry | null;
  snapshotNodes?: readonly SearchableEntry[];
  indexInMatches?: number;
  candidates: SearchableEntry[];
  matches: {
    node: SearchableEntry;
    kind: MatchKind;
    sourceNodes?: SearchableEntry[];
    textOrigin?: "raw" | "displayed";
  }[];
  matchMode: MatchMode;
  scope?: SearchableEntry;
  error?: string;
}

export function isMissingContainerError(error: string | undefined): boolean {
  return /^Container level \d+ not found:/.test(error ?? "");
}

/** The source that satisfied a selector, before action-target promotion. */
export function matchedSourceNode(
  result: ElementResolution,
  selector?: Pick<ResolverSelector, "text" | "caseSensitive">,
): SearchableEntry | undefined {
  const candidate = result.candidates[result.indexInMatches ?? -1] ?? result.chosen;
  const sources = result.matches.find(({ node }) => node === candidate)?.sourceNodes;
  if (!sources?.length) {
    return candidate ?? undefined;
  }
  if (selector?.text === undefined) {
    return sources.find((source) => source !== candidate) ?? sources[0];
  }
  const query = normalize(selector.text, selector.caseSensitive);
  return (
    sources.find((source) =>
      Object.values(source.textSources).some((value) => {
        const actual = normalize(value, selector.caseSensitive);
        return result.matchMode === "contains" ? actual.includes(query) : actual === query;
      }),
    ) ?? sources[0]
  );
}

function normalize(value: string, caseSensitive = false, collapseWhitespace = true): string {
  const normalized = normalizeQuotes(value).trim();
  const text = collapseWhitespace ? normalized.replace(/\s+/g, " ") : normalized;
  return caseSensitive ? text : text.toLowerCase();
}

function qualifiedId(id: string): { packageName: string; name: string } | undefined {
  const separator = id.indexOf(":id/");
  return separator > 0 && separator + 4 < id.length
    ? { packageName: id.slice(0, separator), name: id.slice(separator + 4) }
    : undefined;
}

function centerWithinViewport(
  bounds: ElementBounds,
  viewport: { width: number; height: number },
): boolean {
  return !isElementCenterOffScreen(bounds, viewport);
}

function hasVisibleBounds(
  node: SearchableEntry,
  intent: Pick<ResolutionIntent, "viewport">,
): boolean {
  return !!node.bounds && (!intent.viewport || centerWithinViewport(node.bounds, intent.viewport));
}

/** Choose the nearest actionable node, preserving the matched node separately. */
export function promoteClickableAncestor(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
  intent: Pick<ResolutionIntent, "action" | "requireResourceId" | "viewport">,
  scope?: SearchableEntry,
): SearchableEntry | null {
  const action = intent.action === "long-press" ? "long-press" : "tap";
  let candidate: SearchableEntry | undefined = node;
  while (candidate) {
    if (
      hasVisibleBounds(candidate, intent) &&
      (!intent.requireResourceId || candidate.nativeId) &&
      hasActionAffordance(candidate, { action })
    ) {
      return candidate;
    }
    if (candidate === scope) {
      break;
    }
    candidate = candidate.parentIndex === undefined ? undefined : nodes[candidate.parentIndex];
  }
  return null;
}

function semanticActionsForIntent(intent: ResolutionIntent): SearchableEntry["affordances"] {
  if (intent.action === "scroll") {
    return ["scroll"];
  }
  if (intent.action === "inspect") {
    return ["tap", "toggle"];
  }
  if (intent.action === "long-press") {
    return ["long-press"];
  }
  return intent.action === "input" || intent.action === "focus-input"
    ? ["input"]
    : ["tap", "scroll"];
}

/** Native editable fields and iOS accessibility text-field roles can own focus labels. */
export function isFocusEditableElement(element: Element): boolean {
  return isEditableElementProperties(element) || element.role === "textfield";
}

function containsBounds(container: ElementBounds, contained: ElementBounds): boolean {
  return (
    container.left <= contained.left &&
    container.top <= contained.top &&
    container.right >= contained.right &&
    container.bottom >= contained.bottom
  );
}

function hasActionAffordance(
  node: SearchableEntry,
  intent: Pick<ResolutionIntent, "action">,
): boolean {
  if (intent.action === "focus-input") {
    return isFocusEditableElement(node.properties);
  }
  if (intent.action === "long-press") {
    return node.affordances.some(
      (action) => action === "long-press" || action === "tap" || action === "toggle",
    );
  }
  return node.affordances.some(
    (action) => action === intent.action || (intent.action === "tap" && action === "toggle"),
  );
}

function eligible(node: SearchableEntry, intent: ResolutionIntent): boolean {
  if (intent.requireResourceId && !node.nativeId) {
    return false;
  }
  if (intent.action === "inspect" && !intent.requireBounds) {
    return true;
  }
  if (!hasVisibleBounds(node, intent)) {
    return false;
  }
  if (intent.action === "inspect") {
    return true;
  }
  if (
    intent.action === "highlight" ||
    intent.action === "drag" ||
    intent.action === "accessibility-focus"
  ) {
    return true;
  }
  if (intent.action === "focus") {
    return node.focusable || node.affordances.includes("input");
  }
  return hasActionAffordance(node, intent);
}

function promotableFocusAncestor(
  label: SearchableEntry,
  ancestor: SearchableEntry,
  intent: ResolutionIntent,
): boolean {
  return (
    !!label.bounds &&
    !!ancestor.bounds &&
    containsBounds(ancestor.bounds, label.bounds) &&
    eligible(ancestor, intent)
  );
}

export function isWithin(
  node: SearchableEntry,
  ancestor: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  let parent = node.parentIndex;
  while (parent !== undefined) {
    if (parent === ancestor.index) {
      return true;
    }
    parent = nodes[parent]?.parentIndex;
  }
  return false;
}

function containerSource(
  selector: ResolverSelector,
  resolution: ElementResolution,
): SearchableEntry | undefined {
  const sources = resolution.matches.find(({ node }) => node === resolution.chosen)?.sourceNodes;
  const query = selector.text ?? selector.contentDescription;
  if (query === undefined) {
    return sources?.[0];
  }
  const wanted = normalize(query, selector.caseSensitive);
  return (
    sources?.find((node) => {
      const values =
        selector.contentDescription === undefined
          ? Object.values(node.textSources)
          : [node.textSources["content-desc"]];
      return values.some((value) => {
        const actual = normalize(value ?? "", selector.caseSensitive);
        return resolution.matchMode === "contains" ? actual.includes(wanted) : actual === wanted;
      });
    }) ?? sources?.[0]
  );
}

function sameReferenceProof(node: SearchableEntry, ref: ElementReference): boolean {
  if (ref.bounds === undefined && ref.label === undefined) {
    return false;
  }
  const sameBounds =
    node.bounds && ref.bounds ? boundsEqual(node.bounds, ref.bounds) : node.bounds === ref.bounds;
  return sameBounds && node.label === ref.label && node.nativeId === ref.nativeId;
}

/** Pure selection over projected capture data. No hierarchy acquisition or legacy finder calls. */
export class ElementResolver {
  constructor(private readonly random: () => number = () => defaultRandom.next()) {}

  resolve(
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
  ): ElementResolution {
    return this.resolveInNodes(snapshot, selector, intent, snapshot.nodes);
  }

  private containerFailure(
    selector: ResolverSelector,
    result: ElementResolution,
  ): ElementResolution {
    if (result.error?.startsWith("Container level ")) {
      return result;
    }
    let level = 1;
    for (let parent = selector.container; parent; parent = parent.container) {
      level += 1;
    }
    const ambiguous = /ambiguous/i.test(result.error ?? "");
    return {
      ...result,
      error: `Container level ${level} ${ambiguous ? "ambiguous" : "not found"}: ${selector.elementId ?? selector.text}${ambiguous ? `; ${this.candidateDetails(result.candidates)}` : ""}`,
    };
  }

  private containerSelector(selector: ResolverSelector): ResolverSelector {
    const container = selector.container!;
    return {
      ...container,
      selectionStrategy:
        selector.selectionStrategy === "unique" ? "unique" : container.selectionStrategy,
    };
  }

  private resolveInNodes(
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
    availableNodes: readonly SearchableEntry[],
    boundary?: SearchableEntry,
    preserveTextScope = false,
  ): ElementResolution {
    const seen = new Set<SearchableEntry["source"]>();
    let nodes = [...availableNodes]
      .sort((a, b) => a.windowRank - b.windowRank || a.index - b.index)
      .filter((node) => {
        if (seen.has(node.source)) {
          return false;
        }
        seen.add(node.source);
        return true;
      });
    let scope: SearchableEntry | undefined = boundary;
    let siblingCandidateNodes: SearchableEntry[] | undefined;
    if (selector.container) {
      const container = this.resolveInNodes(
        snapshot,
        this.containerSelector(selector),
        { action: "inspect" },
        nodes,
        scope,
        true,
      );
      if (!container.chosen) {
        return this.containerFailure(selector.container, container);
      }
      // A text match may be promoted to its clickable row. Keep the container
      // rooted at the node that actually supplied the text, so siblings in
      // that row do not become descendants of the requested container.
      scope = containerSource(selector.container, container) ?? container.chosen;
      nodes = nodes.filter((node) => isWithin(node, scope!, snapshot.nodes));
    }
    if (selector.sibling) {
      const siblings = this.siblingNodes(snapshot, nodes, selector, intent, scope);
      if (siblings.error) {
        return {
          chosen: null,
          candidates: [],
          matches: [],
          matchMode: "exact",
          error: siblings.error,
          scope,
        };
      }
      nodes = siblings.nodes;
      siblingCandidateNodes = siblings.candidateNodes;
    }
    const { selected: selectionMatches, all: allMatches } = this.matchSelectionNodes(
      snapshot,
      selector,
      intent,
      { nodes, candidateNodes: siblingCandidateNodes, scope },
    );
    const matched = this.prepareMatches(
      selectionMatches,
      selector,
      snapshot,
      scope,
      intent,
      preserveTextScope,
    );
    const result: ElementResolution = {
      chosen: null,
      snapshotNodes: snapshot.nodes,
      candidates: matched.matches.map(({ node }) => node),
      ...matched,
      scope,
    };
    if (matched.error) {
      return result;
    }
    if (intent.ref) {
      return this.resolveReference(result, snapshot, intent);
    }
    const actionTarget = (node: SearchableEntry | undefined) =>
      intent.action === "highlight" &&
      selector.elementId !== undefined &&
      node &&
      eligible(node, intent)
        ? node
        : this.actionTarget(node, snapshot, intent, scope);
    // Positional selection counts displayed actionable rows; diagnostic
    // matches retain inert labels so debug can still explain why they cannot act.
    const actionableCandidate = (candidate: SearchableEntry) =>
      preserveTextScope
        ? true
        : intent.action === "focus-input"
          ? actionTarget(candidate) !== null
          : actionTarget(candidate) !== null ||
            (hasVisibleBounds(candidate, intent) && candidate.affordances.length > 0);
    result.candidates = result.candidates.filter(actionableCandidate);
    this.rankCandidates(result, selector, actionTarget, intent);
    this.choose(result, selector, actionTarget);
    if (siblingCandidateNodes) {
      // Preserve the complete observed candidate list without letting another
      // anchor's smaller target override the first anchor's chosen sibling.
      const preparedAll = this.prepareMatches(
        allMatches,
        selector,
        snapshot,
        scope,
        intent,
        preserveTextScope,
      );
      result.matches = preparedAll.matches;
      result.candidates = preparedAll.matches.map(({ node }) => node).filter(actionableCandidate);
      if (result.chosen) {
        result.indexInMatches = result.candidates.findIndex(
          (candidate) => actionTarget(candidate) === result.chosen,
        );
      }
    }
    return result;
  }

  private matchSelectionNodes(
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
    options: {
      nodes: SearchableEntry[];
      candidateNodes?: SearchableEntry[];
      scope?: SearchableEntry;
    },
  ) {
    const { nodes, candidateNodes, scope } = options;
    // Apply hint fallback once over the same universe as reported matches.
    const { usedHintFallback, ...all } = this.match(
      candidateNodes ?? nodes,
      selector,
      intent,
      snapshot,
      scope,
    );
    if (!candidateNodes) {
      return { selected: all, all };
    }
    // Keep the established per-anchor primary match mode (including iOS).
    // Only the hint tier is shared across selection and diagnostic candidates.
    const selected = usedHintFallback
      ? { ...all, matches: all.matches.filter(({ node }) => nodes.includes(node)) }
      : this.match(nodes, selector, { ...intent, allowHintFallback: false }, snapshot, scope);
    return { selected, all };
  }

  private rankCandidates(
    result: ElementResolution,
    selector: ResolverSelector,
    actionTarget: (node: SearchableEntry | undefined) => SearchableEntry | null,
    intent: ResolutionIntent,
  ): void {
    if (selector.sibling || intent.action === "scroll") {
      return;
    }
    const rawTextMatch = new Set(
      result.matches.filter((match) => match.textOrigin === "raw").map((match) => match.node),
    );
    const rank = (candidate: SearchableEntry) => {
      const target = actionTarget(candidate) ?? candidate;
      return {
        windowRank: target.windowRank,
        area: target.bounds ? boundsArea(target.bounds) : Infinity,
        order: target.index,
        interactive: intent.preferTap
          ? target.affordances.includes("tap") || target.affordances.includes("toggle")
          : target.affordances.length > 0,
        input: target.affordances.includes("input"),
        // A labelled checkable row may enclose a smaller toggle control;
        // compare their actionable bounds before preferring the row's raw text.
        raw: rawTextMatch.has(candidate) && !target.affordances.includes("toggle"),
      };
    };
    result.candidates.sort((a, b) => compareSelectionRank(rank(a), rank(b), intent.preferTap));
  }

  private toggleMatches(
    matches: ElementResolution["matches"],
    snapshot: ResolverSnapshot,
    intent: ResolutionIntent,
  ): ElementResolution["matches"] {
    const toggles = new Map<SearchableEntry, ElementResolution["matches"][number]>();
    for (const match of matches) {
      for (const node of snapshot.nodes) {
        if (
          node.affordances.includes("toggle") &&
          hasVisibleBounds(node, intent) &&
          (node === match.node || isWithin(node, match.node, snapshot.nodes))
        ) {
          const existing = toggles.get(node);
          toggles.set(node, {
            ...match,
            node,
            sourceNodes: [...new Set([...(existing?.sourceNodes ?? []), match.node])],
          });
        }
      }
    }
    return [...toggles.values()];
  }

  private prepareMatches(
    matched: Pick<ElementResolution, "matches" | "matchMode" | "error">,
    selector: ResolverSelector,
    snapshot: ResolverSnapshot,
    scope: SearchableEntry | undefined,
    intent: ResolutionIntent,
    preserveTextScope: boolean,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    if (intent.preferToggle && selector.index === undefined && selector.elementId === undefined) {
      const toggles = this.toggleMatches(matched.matches, snapshot, intent);
      if (toggles.length > 0) {
        matched.matches = toggles;
      }
    }
    if (preserveTextScope) {
      matched.matches = matched.matches.filter(
        ({ node }) =>
          !matched.matches.some(
            ({ node: other }) => other !== node && isWithin(other, node, snapshot.nodes),
          ),
      );
    } else if (
      !(
        scope &&
        selector.selectionStrategy === "unique" &&
        usesClickablePromotion(intent.action)
      ) &&
      (selector.text !== undefined || selector.contentDescription !== undefined)
    ) {
      matched.matches = this.promoteTextMatches(matched.matches, snapshot, scope, intent);
    }
    return matched;
  }

  private choose(
    result: ElementResolution,
    selector: ResolverSelector,
    actionTarget: (node: SearchableEntry | undefined) => SearchableEntry | null,
  ): ElementResolution {
    const actionable = [
      ...new Set(
        result.candidates
          .map(actionTarget)
          .filter((node): node is SearchableEntry => node !== null),
      ),
    ];
    if (selector.index !== undefined) {
      const selected = result.candidates[selector.index];
      result.chosen = actionTarget(selected);
      if (!result.chosen && selector.selectionStrategy === "unique") {
        result.error = `Target not found${result.scope ? " within container" : ""}: index ${selector.index} is out of range or ineligible`;
      }
    } else if (selector.selectionStrategy === "unique") {
      this.chooseUnique(result, actionable);
    } else if (selector.selectionStrategy === "random") {
      result.chosen =
        actionable[
          Math.min(actionable.length - 1, Math.floor(this.random() * actionable.length))
        ] ?? null;
    } else {
      result.chosen = result.candidates.map(actionTarget).find((node) => node !== null) ?? null;
    }
    if (result.chosen) {
      result.indexInMatches =
        selector.index ??
        result.candidates.findIndex((candidate) => actionTarget(candidate) === result.chosen);
    }
    return result;
  }

  private chooseUnique(result: ElementResolution, candidates: SearchableEntry[]): void {
    // Scoped uniqueness belongs to the matched nodes, even if two of them
    // share one clickable owner. Promotion must not erase ambiguity.
    if (result.scope && result.candidates.length > 1) {
      candidates = result.candidates;
    }
    if (candidates.length === 1) {
      result.chosen = candidates[0];
      return;
    }
    result.error =
      candidates.length === 0
        ? `Target not found${result.scope ? " within container" : ""}`
        : `Target ambiguous: ${candidates.length} matches; ${this.candidateDetails(candidates)}`;
  }

  private candidateDetails(nodes: readonly SearchableEntry[]): string {
    const candidates = nodes
      .slice(0, 5)
      .map(
        (node) =>
          `resourceId=${JSON.stringify(node.nativeId ?? node.nodeKey)}, text=${JSON.stringify(node.label)}, bounds=${JSON.stringify(node.bounds ?? null)}`,
      );
    return `Candidates: ${candidates.join("; ")}. Use a more specific selector or a zero-based index.`;
  }

  private actionTarget(
    node: SearchableEntry | undefined,
    snapshot: ResolverSnapshot,
    intent: ResolutionIntent,
    scope?: SearchableEntry,
  ): SearchableEntry | null {
    if (!node) {
      return null;
    }
    if (intent.action === "focus-input") {
      return this.focusInputTarget(node, snapshot, intent, scope);
    }
    if (usesClickablePromotion(intent.action)) {
      return this.clickableActionTarget(node, snapshot, intent, scope);
    }
    if (eligible(node, intent)) {
      return node;
    }
    let parent = node.parentIndex;
    while (parent !== undefined) {
      const ancestor = snapshot.nodes[parent];
      if (!ancestor || ancestor === scope) {
        break;
      }
      if (eligible(ancestor, intent)) {
        return ancestor;
      }
      parent = ancestor.parentIndex;
    }
    return null;
  }

  private clickableActionTarget(
    node: SearchableEntry,
    snapshot: ResolverSnapshot,
    intent: ResolutionIntent,
    scope?: SearchableEntry,
  ): SearchableEntry | null {
    const promoted = promoteClickableAncestor(node, snapshot.nodes, intent, scope);
    // Containers constrain the match and clickable promotion (including the
    // container itself). If no owner exists inside scope, tap/long-press the
    // matched node's own visible bounds, as the default inspect lookup does.
    // Never search globally or apply this coordinate fallback to focus-input.
    if (
      !promoted &&
      scope &&
      eligible(node, { ...intent, action: "inspect", requireBounds: true })
    ) {
      return node;
    }
    return intent.action === "highlight" && !promoted && eligible(node, intent) ? node : promoted;
  }

  private focusInputTarget(
    node: SearchableEntry,
    snapshot: ResolverSnapshot,
    intent: ResolutionIntent,
    scope?: SearchableEntry,
  ): SearchableEntry | null {
    if (eligible(node, intent)) {
      return node;
    }
    if (node.affordances.length > 0) {
      return null;
    }
    let parent = node.parentIndex;
    let hops = 0;
    while (parent !== undefined && hops < FOCUS_LABEL_ANCESTOR_HOP_LIMIT) {
      hops += 1;
      const ancestor = snapshot.nodes[parent];
      if (!ancestor || ancestor === scope) {
        break;
      }
      if (isFocusEditableElement(ancestor.properties)) {
        return promotableFocusAncestor(node, ancestor, intent) ? ancestor : null;
      }
      if (ancestor.affordances.length > 0) {
        break;
      }
      parent = ancestor.parentIndex;
    }
    return null;
  }

  private siblingNodes(
    snapshot: ResolverSnapshot,
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    scope?: SearchableEntry,
  ): { nodes: SearchableEntry[]; candidateNodes?: SearchableEntry[]; error?: string } {
    const anchors = this.resolveInNodes(
      snapshot,
      selector.sibling!,
      { action: "inspect" },
      nodes,
      scope,
    );
    if (anchors.error) {
      return { nodes: [], error: anchors.error };
    }
    const anchorAlreadyDisambiguated =
      selector.sibling!.index !== undefined || selector.sibling!.selectionStrategy !== undefined;
    const shouldPoolAmbiguousAnchors =
      !anchorAlreadyDisambiguated &&
      selector.selectionStrategy === "random" &&
      selector.index === undefined;
    const selectedAnchors = shouldPoolAmbiguousAnchors ? anchors.candidates : [anchors.chosen];
    const siblings = new Set<SearchableEntry>();
    const allSiblings = new Set<SearchableEntry>();
    for (const chosen of anchors.candidates) {
      const anchor = this.siblingAnchor({ ...anchors, chosen }, snapshot);
      for (const sibling of this.siblingsForAnchor(
        snapshot,
        nodes,
        selector,
        intent,
        scope,
        anchor,
      )) {
        allSiblings.add(sibling);
        if (selectedAnchors.includes(chosen)) {
          siblings.add(sibling);
        }
      }
    }
    return siblings.size > 0
      ? {
          nodes: nodes.filter((node) => siblings.has(node)),
          candidateNodes:
            !anchorAlreadyDisambiguated && selector.index === undefined
              ? nodes.filter((node) => allSiblings.has(node))
              : undefined,
        }
      : { nodes: [], error: "Sibling row not found" };
  }

  private siblingsForAnchor(
    snapshot: ResolverSnapshot,
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    scope: SearchableEntry | undefined,
    anchor: SearchableEntry | undefined,
  ): SearchableEntry[] {
    let parent = anchor?.parentIndex;
    let fallbackNodes: SearchableEntry[] = [];
    while (anchor && parent !== undefined) {
      const row = snapshot.nodes[parent];
      if (!row || row.collection) {
        break;
      }
      const siblings = nodes.filter(
        (node) =>
          isWithin(node, row, snapshot.nodes) &&
          node !== anchor &&
          !isWithin(node, anchor, snapshot.nodes) &&
          !this.crossesCollection(node, row, snapshot.nodes),
      );
      fallbackNodes = siblings;
      if (
        this.match(siblings, selector, { ...intent, allowHintFallback: false }, snapshot, scope)
          .matches.length > 0
      ) {
        return siblings;
      }
      if (row === scope) {
        break;
      }
      parent = row.parentIndex;
    }
    // No primary row matched. Apply the action-only fallback once in resolveInNodes.
    return intent.allowHintFallback && !intent.negative ? fallbackNodes : [];
  }

  private crossesCollection(
    node: SearchableEntry,
    row: SearchableEntry,
    nodes: readonly SearchableEntry[],
  ): boolean {
    let parent = node.parentIndex;
    while (parent !== undefined && nodes[parent] !== row) {
      const ancestor = nodes[parent];
      if (!ancestor || ancestor.collection) {
        return true;
      }
      parent = ancestor.parentIndex;
    }
    return parent === undefined;
  }

  private siblingAnchor(
    anchors: ElementResolution,
    snapshot: ResolverSnapshot,
  ): SearchableEntry | undefined {
    const matched = anchors.matches.find(({ node }) => node === anchors.chosen);
    const sources = matched?.sourceNodes ?? (anchors.chosen ? [anchors.chosen] : []);
    // Text promotion may choose the actionable row. Anchor sibling traversal on
    // its matching descendant label instead of stepping outside that row.
    return sources.find(
      (source) =>
        !sources.some((other) => other !== source && isWithin(other, source, snapshot.nodes)),
    );
  }

  private semanticTarget(
    node: SearchableEntry,
    snapshot: ResolverSnapshot,
    scope: SearchableEntry | undefined,
    intent: ResolutionIntent,
  ): SearchableEntry {
    if (intent.action === "focus-input") {
      return this.actionTarget(node, snapshot, intent, scope) ?? node;
    }
    if (usesClickablePromotion(intent.action)) {
      return promoteClickableAncestor(node, snapshot.nodes, intent, scope) ?? node;
    }
    if (node.affordances.length > 0) {
      return node;
    }
    let parent = node.parentIndex;
    while (parent !== undefined) {
      const ancestor = snapshot.nodes[parent];
      if (!ancestor || ancestor === scope) {
        break;
      }
      const targetActions = semanticActionsForIntent(intent);
      if (
        ancestor.bounds &&
        targetActions.some((action) => ancestor.affordances.includes(action))
      ) {
        return ancestor;
      }
      parent = ancestor.parentIndex;
    }
    return node;
  }

  private promoteTextMatches(
    matches: ElementResolution["matches"],
    snapshot: ResolverSnapshot,
    scope: SearchableEntry | undefined,
    intent: ResolutionIntent,
  ): ElementResolution["matches"] {
    const unique = new Map<number, ElementResolution["matches"][number]>();
    for (const match of matches) {
      const target = this.semanticTarget(match.node, snapshot, scope, intent);
      const existing = unique.get(target.index);
      const sourceNodes = match.sourceNodes ?? [match.node];
      if (existing) {
        if (match.textOrigin === "raw") {
          existing.textOrigin = "raw";
        }
        existing.sourceNodes = [
          ...new Set([...(existing.sourceNodes ?? [existing.node]), ...sourceNodes]),
        ];
      } else {
        unique.set(target.index, { ...match, node: target, sourceNodes });
      }
    }
    return [...unique.values()].sort(
      (a, b) => a.node.windowRank - b.node.windowRank || a.node.index - b.node.index,
    );
  }

  private match(
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    snapshot: ResolverSnapshot,
    scope?: SearchableEntry,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> & { usedHintFallback?: boolean } {
    if (selector.elementId !== undefined) {
      return this.matchId(
        nodes,
        selector.elementId,
        selector.match ?? "exact",
        intent,
        selector.caseSensitive,
      );
    }
    if (selector.testTag !== undefined) {
      return {
        matches: nodes
          .filter((node) => node.testTag === selector.testTag)
          .map((node) => ({ node, kind: "test-tag-exact" })),
        matchMode: "exact",
      };
    }
    if (selector.className !== undefined) {
      return {
        matches: nodes
          .filter((node) => node.className === selector.className)
          .map((node) => ({ node, kind: "class-exact" })),
        matchMode: "exact",
      };
    }
    const textQuery = selector.text ?? selector.contentDescription;
    if (textQuery === undefined) {
      return {
        matches: nodes
          .filter((node) => eligible(node, intent))
          .map((node) => ({ node, kind: "all" })),
        matchMode: "exact",
      };
    }
    const primary = this.matchText(nodes, selector, intent, textQuery, snapshot, { scope });
    // Preserve every existing text match (including substrings) before considering
    // Android placeholders. Mixing the tiers would change targets and uniqueness.
    // Reuse the same exact/contains/regex rules within the hint-only tier.
    if (
      intent.allowHintFallback === true &&
      !intent.negative &&
      selector.contentDescription === undefined &&
      primary.matches.length === 0 &&
      !primary.error
    ) {
      return {
        ...this.matchText(nodes, selector, intent, textQuery, snapshot, {
          scope,
          hintFallback: true,
        }),
        usedHintFallback: true,
      };
    }
    return primary;
  }

  private matchableTextFields(
    node: SearchableEntry,
    selector: ResolverSelector,
    hintFallback: boolean | undefined,
  ): readonly string[] {
    if (hintFallback) {
      const hint = node.properties["hint-text"];
      const android =
        node.className?.startsWith("android.") ||
        node.className?.startsWith("androidx.") ||
        (typeof node.properties["input-type"] === "string" &&
          node.properties["input-type"].trim() !== "");
      return android &&
        isEditableElementProperties(node.properties) &&
        typeof hint === "string" &&
        hint.trim() !== ""
        ? [hint]
        : [];
    }
    return selector.contentDescription !== undefined
      ? [node.textSources["content-desc"], node.accessibleLabel].filter(
          (value): value is string => value !== undefined,
        )
      : node.textFields;
  }

  private matchText(
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    textQuery: string,
    snapshot: ResolverSnapshot,
    options: { scope?: SearchableEntry; hintFallback?: boolean },
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    const { scope, hintFallback } = options;
    const fields = (node: SearchableEntry) =>
      this.matchableTextFields(node, selector, hintFallback);
    const query = normalize(textQuery, selector.caseSensitive);
    if (!query) {
      return { matches: [], matchMode: "exact", error: "Text selector must not be blank" };
    }
    const exact = nodes.filter((node) =>
      fields(node).some((field) => normalize(field, selector.caseSensitive) === query),
    );
    const requested = intent.matchMode ?? selector.match;
    const eligibleExact = this.hasEligibleExactTextMatch(exact, intent, snapshot, scope);
    const matchMode =
      intent.negative && requested !== "regex"
        ? "exact"
        : (requested ?? (eligibleExact ? "exact" : "contains"));
    let regex: RegExp | undefined;
    if (matchMode === "regex") {
      try {
        regex = new RegExp(normalizeQuotes(textQuery), selector.caseSensitive ? "" : "i");
      } catch (error) {
        return {
          matches: [],
          matchMode,
          error: `Invalid text selector regular expression: ${String(error)}`,
        };
      }
    }
    const matches =
      matchMode === "exact"
        ? exact
        : nodes.filter((node) =>
            fields(node).some((field) =>
              regex
                ? regex.test(normalizeQuotes(field))
                : normalize(field, selector.caseSensitive).includes(query),
            ),
          );
    return {
      matches: matches.map((node) => ({
        node,
        kind: matchMode === "exact" ? "text-exact" : matchMode,
        textOrigin:
          matchMode === "exact" &&
          Object.values(node.textSources).some(
            (value) => normalize(value, selector.caseSensitive) === query,
          )
            ? "raw"
            : "displayed",
      })),
      matchMode,
    };
  }

  private hasEligibleExactTextMatch(
    exact: SearchableEntry[],
    intent: ResolutionIntent,
    snapshot: ResolverSnapshot,
    scope?: SearchableEntry,
  ): boolean {
    if (intent.action === "focus-input") {
      return exact.some(
        (node) =>
          eligible(node, intent) || this.focusInputTarget(node, snapshot, intent, scope) !== null,
      );
    }
    return intent.action === "input" || intent.action === "focus"
      ? exact.some((node) => eligible(node, intent))
      : exact.length > 0;
  }

  private matchId(
    nodes: SearchableEntry[],
    query: string,
    matchMode: MatchMode,
    intent: ResolutionIntent,
    caseSensitive?: boolean,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    if (matchMode === "regex") {
      return {
        matches: [],
        matchMode,
        error: "Element ID selectors do not support regular expressions",
      };
    }
    if (matchMode === "contains") {
      const normalizedQuery = normalize(query, caseSensitive, false);
      return {
        matches: nodes
          .filter((node) =>
            normalize(node.elementId ?? "", caseSensitive, false).includes(normalizedQuery),
          )
          .map((node) => ({ node, kind: "contains" })),
        matchMode,
      };
    }
    const native = nodes.filter((node) => node.nativeId === query);
    const usableNative = intent.requireBounds ? native.filter((node) => node.bounds) : native;
    if (usableNative.length > 0) {
      return {
        matches: usableNative.map((node) => ({ node, kind: "native-id-exact" })),
        matchMode,
      };
    }
    const qualified = qualifiedId(query);
    const direct = nodes.filter(
      (node) => node.nodeKey === query && (!intent.requireBounds || node.bounds),
    );
    if (
      direct.length > 1 &&
      !syntheticNodeKey.test(query) &&
      direct.every((node) => !node.nativeId)
    ) {
      return {
        matches: [],
        matchMode,
        error: `Skeleton element id "${query}" is ambiguous: ${direct.length} id-less nodes share this view-id. Use text with index instead.`,
      };
    }
    if (direct.length) {
      return {
        matches: direct.map((node) => ({
          node,
          kind: node.nativeId === query ? "native-id-exact" : "node-key-exact",
        })),
        matchMode,
      };
    }
    const namespace = nodes.filter(
      (node) =>
        node.nativeId &&
        (!intent.requireBounds || node.bounds) &&
        (qualified ? node.nativeId === qualified.name : qualifiedId(node.nativeId)?.name === query),
    );
    if (namespace.length === 0 && native.length > 0) {
      return {
        matches: native.map((node) => ({ node, kind: "native-id-exact" })),
        matchMode,
      };
    }
    const candidates = [...new Set([...direct, ...namespace])];
    const packages = new Set(
      candidates
        .map((node) => node.nativeId && qualifiedId(node.nativeId)?.packageName)
        .filter(Boolean),
    );
    const matches = candidates
      .sort((a, b) => a.windowRank - b.windowRank || a.index - b.index)
      .map((node) => ({
        node,
        kind: (node.nativeId === query
          ? "native-id-exact"
          : node.nodeKey === query
            ? "node-key-exact"
            : "id-namespace") as MatchKind,
      }));
    return {
      matches,
      matchMode,
      ...(packages.size > 1
        ? {
            error: `Ambiguous element ID ${query}: ${candidates.map((node) => node.nativeId).join(", ")}. Use a full resource ID.`,
          }
        : {}),
    };
  }

  private resolveReference(
    result: ElementResolution,
    snapshot: ResolverSnapshot,
    intent: ResolutionIntent,
  ): ElementResolution {
    const ref = intent.ref!;
    const matches = result.candidates.filter((node) => node.nodeKey === ref.nodeKey);
    const node = matches.length === 1 ? matches[0] : undefined;
    // A positional -k id is unsafe under reorder even when reference proof
    // succeeds: another peer can move into its ordinal. A ~text suffix follows
    // the same proof as a bare stable id, though its text can still change.
    const uniqueNativeId =
      node?.nativeId &&
      new Set(
        snapshot.nodes
          .filter((entry) => entry.nativeId === node.nativeId)
          .map((entry) => entry.source),
      ).size === 1;
    const valid =
      node &&
      (snapshot.id === ref.snapshotId ||
        ((!ordinalNodeKey.test(ref.nodeKey) || uniqueNativeId) && sameReferenceProof(node, ref)));
    if (!valid) {
      return { ...result, error: `Stale reference ${ref.nodeKey}; observe again before acting.` };
    }
    return {
      ...result,
      chosen: eligible(node, intent) ? node : null,
      indexInMatches: result.candidates.indexOf(node),
    };
  }
}
