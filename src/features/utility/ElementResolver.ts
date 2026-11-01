import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import { isImeKeyEntry, type SearchableEntry } from "./SearchableNode";
import { normalizeQuotes } from "./TextMatcher";
import { boundsArea } from "../../utils/bounds";
import { defaultRandom } from "../../utils/Random";
import { isEditableElementProperties } from "./elementProperties";
import { compareSelectionRank, selectableCandidates } from "./selectionRank";
import type { ElementResolution, ResolutionIntent, ResolverSnapshot } from "./ElementResolverTypes";
import {
  syntheticNodeKey,
  normalize,
  matchTestTag,
  guardNamespaceNodes,
  matchId,
} from "./ElementResolverMatching";
import {
  usesClickablePromotion,
  hasVisibleBounds,
  promoteClickableAncestor,
  semanticActionsForIntent,
  isFocusEditableElement,
  eligible,
  promotableFocusAncestor,
  preferVisibleMatches,
  isIdOnlySelector,
  preferCapturedContainerMatches,
  isWithin,
  containerSource,
  resolveReference,
} from "./ElementResolverNodes";
export type {
  MatchMode,
  ResolutionAction,
  ResolverSnapshot,
  ResolutionIntent,
  ContainerFailure,
  ElementResolution,
} from "./ElementResolverTypes";
export { matchedSourceNode } from "./ElementResolverMatching";

/** The node a search is confined to, and whether a container keeps its text scope. */
interface NodeScope {
  scope?: SearchableEntry;
  preserveTextScope?: boolean;
}
export {
  isMissingContainerError,
  promoteClickableAncestor,
  isFocusEditableElement,
  isWithin,
} from "./ElementResolverNodes";

// Keep label promotion within a parent or grandparent, away from distant editable ancestors.
const FOCUS_LABEL_ANCESTOR_HOP_LIMIT = 2;

export class ElementResolver {
  constructor(private readonly random: () => number = () => defaultRandom.next()) {}

  resolve(
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
  ): ElementResolution {
    // Keyboard keys are not part of what `observe` presents, so an action's selector
    // cannot see them (issue #10225). Indices stay snapshot indices, so only the
    // searched list shrinks.
    const available = snapshot.searchedNodes ?? snapshot.nodes;
    const searched = intent.excludeImeKeys
      ? available.filter((node) => !isImeKeyEntry(node))
      : available;
    return this.resolveInNodes(snapshot, selector, intent, { availableNodes: searched });
  }

  private containerFailure(
    selector: ResolverSelector,
    result: ElementResolution,
  ): ElementResolution {
    if (result.containerFailure) {
      return result;
    }
    let level = 1;
    for (let parent = selector.container; parent; parent = parent.container) {
      level += 1;
    }
    const ambiguous = result.failureReason === "ambiguous";
    return {
      ...result,
      containerFailure: {
        level,
        reason: ambiguous ? "ambiguous" : "not-found",
        selector,
      },
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
    {
      availableNodes,
      scope: boundary,
      preserveTextScope,
    }: NodeScope & { availableNodes: readonly SearchableEntry[] },
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
    const scopeMetadata: Pick<ElementResolution, "scopeChain"> = {};
    let siblingCandidateNodes: SearchableEntry[] | undefined;
    if (selector.container) {
      const container = this.resolveInNodes(
        snapshot,
        this.containerSelector(selector),
        { action: "inspect" },
        { availableNodes: nodes, scope, preserveTextScope: true },
      );
      if (!container.chosen) {
        return this.containerFailure(selector.container, container);
      }
      // A text match may be promoted to its clickable row. Keep the container
      // rooted at the node that actually supplied the text, so siblings in
      // that row do not become descendants of the requested container.
      scope = containerSource(selector.container, container) ?? container.chosen;
      scopeMetadata.scopeChain = [
        ...(container.scopeChain ?? []),
        {
          selector: this.containerSelector(selector),
          node: scope,
          matchCount: container.candidates.length,
        },
      ];
      nodes = nodes.filter((node) => isWithin(node, scope!, snapshot.nodes));
    }
    if (selector.sibling) {
      const siblings = this.siblingNodes(snapshot, nodes, selector, { intent, scope });
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
    const matched = this.prepareMatches(selectionMatches, selector, snapshot, {
      intent,
      scope,
      preserveTextScope,
    });
    const result: ElementResolution = {
      chosen: null,
      snapshotNodes: snapshot.nodes,
      candidates: matched.matches.map(({ node }) => node),
      ...matched,
      scope,
      ...scopeMetadata,
    };
    if (matched.error) {
      return result;
    }
    if (intent.ref) {
      return resolveReference(result, snapshot, intent);
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
    const selectable = (candidates: SearchableEntry[]) =>
      preserveTextScope ||
      (scope &&
        selector.selectionStrategy === "unique" &&
        selector.index === undefined &&
        usesClickablePromotion(intent.action))
        ? candidates.filter(actionableCandidate)
        : selectableCandidates(candidates, (candidate) =>
            actionableCandidate(candidate) ? (actionTarget(candidate) ?? candidate) : null,
          );
    result.candidates = selectable(result.candidates);
    this.rankCandidates(result, selector, actionTarget, intent);
    this.choose(result, selector, actionTarget);
    if (siblingCandidateNodes) {
      // Preserve the complete observed candidate list without letting another
      // anchor's smaller target override the first anchor's chosen sibling.
      const preparedAll = this.prepareMatches(allMatches, selector, snapshot, {
        intent,
        scope,
        preserveTextScope,
      });
      result.matches = preparedAll.matches;
      result.candidates = selectable(preparedAll.matches.map(({ node }) => node));
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
    const { usedHintFallback, ...all } = this.match(candidateNodes ?? nodes, selector, intent, {
      snapshot,
      scope,
    });
    if (!candidateNodes) {
      return { selected: all, all };
    }
    // Keep the established per-anchor primary match mode (including iOS).
    // Only the hint tier is shared across selection and diagnostic candidates.
    const selected = usedHintFallback
      ? { ...all, matches: all.matches.filter(({ node }) => nodes.includes(node)) }
      : this.match(nodes, selector, { ...intent, allowHintFallback: false }, { snapshot, scope });
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
    matched: Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason">,
    selector: ResolverSelector,
    snapshot: ResolverSnapshot,
    { intent, scope, preserveTextScope }: NodeScope & { intent: ResolutionIntent },
  ): Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason"> {
    matched.matches = preferVisibleMatches(matched.matches, snapshot.nodes);
    if (intent.preferToggle && selector.index === undefined && selector.elementId === undefined) {
      const toggles = this.toggleMatches(matched.matches, snapshot, intent);
      if (toggles.length > 0) {
        matched.matches = toggles;
      }
    }
    if (preserveTextScope) {
      // A text container keeps the innermost node that carries the text. An id
      // container keeps the outermost one: an iOS container with an identifier
      // can be captured twice, the real node plus an empty nested node with the
      // same id, and only the outer node holds the container's children (#10266).
      const keepOutermost = isIdOnlySelector(selector);
      if (keepOutermost) {
        matched.matches = preferCapturedContainerMatches(matched.matches);
      }
      matched.matches = matched.matches.filter(
        ({ node }) =>
          !matched.matches.some(
            ({ node: other }) =>
              other !== node &&
              (keepOutermost
                ? isWithin(node, other, snapshot.nodes)
                : isWithin(other, node, snapshot.nodes)),
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
      this.chooseUnique(result, actionable, selector);
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

  private chooseUnique(
    result: ElementResolution,
    candidates: SearchableEntry[],
    selector: ResolverSelector,
  ): void {
    // Scoped uniqueness belongs to the matched nodes, even if two of them
    // share one clickable owner. Promotion must not erase ambiguity.
    if (result.scope && result.candidates.length > 1) {
      candidates = result.candidates;
    }
    if (candidates.length === 1) {
      result.chosen = candidates[0];
      return;
    }
    result.failureReason = candidates.length === 0 ? "not-found" : "ambiguous";
    result.error =
      candidates.length === 0
        ? `Target not found${result.scope ? " within container" : ""}${
            selector.elementId !== undefined && syntheticNodeKey.test(selector.elementId)
              ? ": stale element id from an earlier observation. s2- ids are valid only for the observation that returned them. Re-observe and use the new id."
              : ""
          }`
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
    { intent, scope }: { intent: ResolutionIntent; scope?: SearchableEntry },
  ): { nodes: SearchableEntry[]; candidateNodes?: SearchableEntry[]; error?: string } {
    const anchors = this.resolveInNodes(
      snapshot,
      selector.sibling!,
      { action: "inspect" },
      { availableNodes: nodes, scope },
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
      for (const sibling of this.siblingsForAnchor(snapshot, nodes, selector, {
        intent,
        scope,
        anchor,
      })) {
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
    {
      intent,
      scope,
      anchor,
    }: { intent: ResolutionIntent; scope?: SearchableEntry; anchor?: SearchableEntry },
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
        this.match(siblings, selector, { ...intent, allowHintFallback: false }, { snapshot, scope })
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
    { snapshot, scope }: { snapshot: ResolverSnapshot; scope?: SearchableEntry },
  ): Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason"> & {
    usedHintFallback?: boolean;
  } {
    if (selector.elementId !== undefined) {
      return matchId(nodes, selector.elementId, selector.match ?? "exact", {
        intent,
        caseSensitive: selector.caseSensitive,
        captureNodes: guardNamespaceNodes(snapshot.nodes, intent, snapshot.searchedNodes),
      });
    }
    if (selector.testTag !== undefined) {
      return { matches: matchTestTag(nodes, selector.testTag), matchMode: "exact" };
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
    const primary = this.matchText(nodes, selector, intent, {
      snapshot,
      options: { textQuery, scope },
    });
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
        ...this.matchText(nodes, selector, intent, {
          snapshot,
          options: {
            textQuery,
            scope,
            hintFallback: true,
          },
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
    {
      snapshot,
      options,
    }: {
      snapshot: ResolverSnapshot;
      options: { textQuery: string; scope?: SearchableEntry; hintFallback?: boolean };
    },
  ): Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason"> {
    const { textQuery, scope, hintFallback } = options;
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
}
