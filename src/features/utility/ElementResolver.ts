import {
  STABLE_VIEW_ID_PREFIX,
  STABLE_VIEW_ID_HASH_LENGTH,
} from "../observe/android/StableNodeIdentity";

import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import type { SearchableEntry } from "./SearchableNode";
import { normalizeQuotes } from "./TextMatcher";
import { boundsArea, boundsEqual } from "../../utils/bounds";
import type { ElementBounds } from "../../models/ElementBounds";
import { defaultRandom } from "../../utils/Random";

const ordinalNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}-\\d+$`,
);

export type MatchMode = "exact" | "contains" | "regex";
export type ResolutionAction =
  | "inspect"
  | "tap"
  | "long-press"
  | "scroll"
  | "input"
  | "accessibility-focus"
  | "focus"
  | "highlight"
  | "drag";
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
  viewport?: { width: number; height: number };
  requireResourceId?: boolean;
  negative?: boolean;
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
  indexInMatches?: number;
  candidates: SearchableEntry[];
  matches: { node: SearchableEntry; kind: MatchKind; sourceNodes?: SearchableEntry[] }[];
  matchMode: MatchMode;
  scope?: SearchableEntry;
  error?: string;
}

function normalize(value: string, caseSensitive = false): string {
  const normalized = normalizeQuotes(value).trim();
  return caseSensitive ? normalized : normalized.toLowerCase();
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
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

function inspectEligible(node: SearchableEntry, viewport?: ResolutionIntent["viewport"]): boolean {
  return !viewport || !node.bounds || centerWithinViewport(node.bounds, viewport);
}

function eligible(node: SearchableEntry, intent: ResolutionIntent): boolean {
  if (intent.requireResourceId && !node.nativeId) {
    return false;
  }
  if (intent.action === "inspect") {
    return inspectEligible(node, intent.viewport);
  }
  if (!node.bounds) {
    return false;
  }
  if (intent.viewport && !centerWithinViewport(node.bounds, intent.viewport)) {
    return false;
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
  return node.affordances.some(
    (action) => action === intent.action || (intent.action === "tap" && action === "toggle"),
  );
}

function isWithin(
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

function shouldPromoteText(selector: ResolverSelector, intent: ResolutionIntent): boolean {
  return (
    (selector.text !== undefined || selector.contentDescription !== undefined) &&
    intent.action !== "drag" &&
    intent.action !== "highlight"
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
    if (selector.container) {
      const container = this.resolveInNodes(
        snapshot,
        selector.container,
        { action: "inspect" },
        nodes,
        scope,
        true,
      );
      if (!container.chosen) {
        return { ...container, error: container.error ?? "Container not found" };
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
    }
    const matched = this.prepareMatches(
      this.match(nodes, selector, intent),
      selector,
      snapshot,
      scope,
      intent,
      preserveTextScope,
    );
    const result: ElementResolution = {
      chosen: null,
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
      this.actionTarget(node, snapshot, intent, scope);
    // Positional selection counts displayed actionable rows; diagnostic
    // matches retain inert labels so debug can still explain why they cannot act.
    result.candidates = result.candidates.filter(
      (candidate) =>
        actionTarget(candidate) !== null ||
        (!!candidate.bounds &&
          candidate.affordances.length > 0 &&
          (!intent.viewport || centerWithinViewport(candidate.bounds, intent.viewport))),
    );
    return this.choose(result, selector, actionTarget);
  }

  private prepareMatches(
    matched: Pick<ElementResolution, "matches" | "matchMode" | "error">,
    selector: ResolverSelector,
    snapshot: ResolverSnapshot,
    scope: SearchableEntry | undefined,
    intent: ResolutionIntent,
    preserveTextScope: boolean,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    if (preserveTextScope) {
      matched.matches = matched.matches.filter(
        ({ node }) =>
          !matched.matches.some(
            ({ node: other }) => other !== node && isWithin(other, node, snapshot.nodes),
          ),
      );
    } else if (shouldPromoteText(selector, intent)) {
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
    } else if (selector.selectionStrategy === "random") {
      result.chosen =
        actionable[
          Math.min(actionable.length - 1, Math.floor(this.random() * actionable.length))
        ] ?? null;
    } else {
      result.chosen =
        [...actionable].sort(
          (a, b) =>
            a.windowRank - b.windowRank ||
            (a.bounds ? boundsArea(a.bounds) : Infinity) -
              (b.bounds ? boundsArea(b.bounds) : Infinity) ||
            a.index - b.index,
        )[0] ?? null;
    }
    if (result.chosen) {
      result.indexInMatches =
        selector.index ??
        result.candidates.findIndex((candidate) => actionTarget(candidate) === result.chosen);
    }
    return result;
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

  private siblingNodes(
    snapshot: ResolverSnapshot,
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    scope?: SearchableEntry,
  ): { nodes: SearchableEntry[]; error?: string } {
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
    const selected = new Set<SearchableEntry>();
    const anchorMatches =
      selector.sibling!.index !== undefined || selector.sibling!.selectionStrategy === "random"
        ? anchors.matches.filter(({ node }) => node === anchors.chosen)
        : anchors.matches;
    for (const match of anchorMatches) {
      const anchor = this.siblingAnchor(match, snapshot);
      for (const node of this.matchingSiblingRow(
        snapshot,
        nodes,
        selector,
        intent,
        scope,
        anchor,
      )) {
        selected.add(node);
      }
    }
    return selected.size
      ? { nodes: nodes.filter((node) => selected.has(node)) }
      : { nodes: [], error: "Sibling row not found" };
  }

  private matchingSiblingRow(
    snapshot: ResolverSnapshot,
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    scope: SearchableEntry | undefined,
    anchor: SearchableEntry | undefined,
  ): SearchableEntry[] {
    let parent = anchor?.parentIndex;
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
      if (this.match(siblings, selector, intent).matches.length > 0) {
        return siblings;
      }
      if (row === scope) {
        break;
      }
      parent = row.parentIndex;
    }
    return [];
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
    match: ElementResolution["matches"][number],
    snapshot: ResolverSnapshot,
  ): SearchableEntry | undefined {
    const sources = match.sourceNodes ?? [match.node];
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
    if (node.affordances.length > 0) {
      return node;
    }
    let parent = node.parentIndex;
    while (parent !== undefined) {
      const ancestor = snapshot.nodes[parent];
      if (!ancestor || ancestor === scope) {
        break;
      }
      const targetActions: SearchableEntry["affordances"][number][] =
        intent.action === "scroll"
          ? ["scroll"]
          : intent.action === "long-press"
            ? ["long-press"]
            : intent.action === "input" || intent.action === "focus"
              ? ["input"]
              : ["tap", "scroll"];
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
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    if (selector.elementId !== undefined) {
      return this.matchId(nodes, selector.elementId, selector.match ?? "exact");
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
    return this.matchText(nodes, selector, intent, textQuery);
  }

  private matchText(
    nodes: SearchableEntry[],
    selector: ResolverSelector,
    intent: ResolutionIntent,
    textQuery: string,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    const fields = (node: SearchableEntry): readonly string[] =>
      selector.contentDescription !== undefined
        ? [node.textSources["content-desc"], node.accessibleLabel].filter(
            (value): value is string => value !== undefined,
          )
        : node.textFields;
    const query = normalize(textQuery, selector.caseSensitive);
    if (!query) {
      return { matches: [], matchMode: "exact", error: "Text selector must not be blank" };
    }
    const exact = nodes.filter((node) =>
      fields(node).some((field) => normalize(field, selector.caseSensitive) === query),
    );
    const requested = intent.matchMode ?? selector.match;
    const eligibleExact = this.hasEligibleExactTextMatch(exact, intent);
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
      })),
      matchMode,
    };
  }

  private hasEligibleExactTextMatch(exact: SearchableEntry[], intent: ResolutionIntent): boolean {
    return exact.some((node) => {
      if (intent.action === "input" || intent.action === "focus") {
        return eligible(node, intent);
      }
      if (intent.action === "drag" || intent.action === "highlight") {
        return node.bounds !== undefined;
      }
      return true;
    });
  }

  private matchId(
    nodes: SearchableEntry[],
    query: string,
    matchMode: MatchMode,
  ): Pick<ElementResolution, "matches" | "matchMode" | "error"> {
    if (matchMode === "regex") {
      return {
        matches: [],
        matchMode,
        error: "Element ID selectors do not support regular expressions",
      };
    }
    if (matchMode === "contains") {
      return {
        matches: nodes
          .filter((node) => node.elementId?.includes(query))
          .map((node) => ({ node, kind: "contains" })),
        matchMode,
      };
    }
    const native = nodes.filter((node) => node.nativeId === query);
    if (native.length > 0) {
      return {
        matches: native.map((node) => ({ node, kind: "native-id-exact" })),
        matchMode,
      };
    }
    const qualified = qualifiedId(query);
    const direct = nodes.filter((node) => node.nodeKey === query);
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
        (qualified ? node.nativeId === qualified.name : qualifiedId(node.nativeId)?.name === query),
    );
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
    // Duplicate-generated ordinals are capture-local. Identical content and
    // geometry cannot prove that a peer did not move into the old ordinal.
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
