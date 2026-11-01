import {
  STABLE_VIEW_ID_PREFIX,
  STABLE_VIEW_ID_HASH_LENGTH,
  STABLE_VIEW_ID_TEXT_HASH_LENGTH,
} from "../observe/android/StableNodeIdentity";
import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import { isImeKeyEntry, type SearchableEntry } from "./SearchableNode";
import { normalizeQuotes } from "./TextMatcher";
import type {
  ElementResolution,
  MatchKind,
  MatchMode,
  ResolutionIntent,
} from "./ElementResolverTypes";
import {
  ambiguousStableViewIdMessage,
  legacyBareStableViewIdMessage,
} from "./StableViewIdGuidance";

const bareSyntheticNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}$`,
);

export const syntheticNodeKey = new RegExp(
  `^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}}(?:-\\d+|~[0-9a-f]{${STABLE_VIEW_ID_TEXT_HASH_LENGTH}})?$`,
);

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

export function normalize(value: string, caseSensitive = false, collapseWhitespace = true): string {
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

/**
 * A test tag matches a node's `test-tag` first. When no node carries that tag, it falls back to
 * a node whose `resource-id` is exactly the tag and that has no `test-tag` of its own: Compose
 * with `testTagsAsResourceId` (including the AutoMobile prototype) reports `Modifier.testTag` only
 * as the bare `resource-id`, since CtrlProxy fills `test-tag` from accessibility extras (#10626).
 * The fallback is exact only (no `pkg:id/` suffix match), so a classic View id matches only
 * when the full id is given.
 */
export function matchTestTag(
  nodes: readonly SearchableEntry[],
  testTag: string,
): { node: SearchableEntry; kind: MatchKind }[] {
  const tagged = nodes.filter((node) => node.testTag === testTag);
  if (tagged.length > 0) {
    return tagged.map((node) => ({ node, kind: "test-tag-exact" }));
  }
  return nodes
    .filter((node) => node.testTag === undefined && node.nativeId === testTag)
    .map((node) => ({ node, kind: "test-tag-resource-id" }));
}

/** Pure selection over projected capture data. No hierarchy acquisition. */
/**
 * Bare ids are unique per namespace (app vs IME), so when IME keys are excluded
 * the synthetic-id guard must not count them as family peers.
 */
export function guardNamespaceNodes(
  nodes: readonly SearchableEntry[],
  intent: ResolutionIntent,
  searchedNodes: readonly SearchableEntry[] = nodes,
): readonly SearchableEntry[] {
  return intent.excludeImeKeys
    ? searchedNodes.filter((node) => !isImeKeyEntry(node))
    : searchedNodes;
}

/** How an element-id query compares, and which captured nodes guard bare synthetic ids. */
interface IdMatchOptions {
  caseSensitive?: boolean;
  /** Defaults to the searched nodes. */
  captureNodes?: readonly SearchableEntry[];
}

export function matchId(
  nodes: SearchableEntry[],
  query: string,
  matchMode: MatchMode,
  { intent, caseSensitive, captureNodes = nodes }: IdMatchOptions & { intent: ResolutionIntent },
): Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason"> {
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
  const guard = bareSyntheticIdGuard(captureNodes, query);
  if (guard) {
    return { matches: [], matchMode, failureReason: "ambiguous", error: guard };
  }
  return matchNodeKeyOrNamespace(nodes, query, matchMode, { intent, native });
}

function matchNodeKeyOrNamespace(
  nodes: SearchableEntry[],
  query: string,
  matchMode: MatchMode,
  { intent, native }: { intent: ResolutionIntent; native: SearchableEntry[] },
): Pick<ElementResolution, "matches" | "matchMode" | "error" | "failureReason"> {
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
      failureReason: "ambiguous",
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
          failureReason: "ambiguous" as const,
          error: `Ambiguous element ID ${query}: ${candidates.map((node) => node.nativeId).join(", ")}. Use a full resource ID.`,
        }
      : {}),
  };
}

/** Distinct synthetic keys in the capture sharing `base`, bare or suffixed. */
function stableViewIdFamilyKeys(captureNodes: readonly SearchableEntry[], base: string): string[] {
  // The same element can appear in the main hierarchy and a window copy; count
  // it once (same object, or same key at the same bounds).
  const seen = new Set<string>();
  const seenSources = new Set<unknown>();
  const keys: string[] = [];
  for (const node of captureNodes) {
    const key = node.nodeKey;
    if (
      key === undefined ||
      !syntheticNodeKey.test(key) ||
      !(key === base || key.startsWith(`${base}-`) || key.startsWith(`${base}~`)) ||
      seenSources.has(node.source)
    ) {
      continue;
    }
    seenSources.add(node.source);
    const placement = `${key}|${JSON.stringify(node.bounds ?? null)}`;
    if (!seen.has(placement)) {
      seen.add(placement);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Guidance for a bare `s2-<hash>` selector that cannot name one element:
 * a legacy bare-plus-later-ordinal family, or several peers sharing the base
 * (the producer suffixes every duplicate, so the bare id matches none of
 * them). Counted over the whole capture (#10476).
 */
function bareSyntheticIdGuard(
  captureNodes: readonly SearchableEntry[],
  query: string,
): string | null {
  if (!bareSyntheticNodeKey.test(query)) {
    return null;
  }
  const keys = stableViewIdFamilyKeys(captureNodes, query);
  const hasBare = keys.includes(query);
  const hasFirstOrdinal = keys.includes(`${query}-1`);
  const hasLaterOrdinal = keys.some((key) => key.startsWith(`${query}-`) && key !== `${query}-1`);
  if (hasBare && hasLaterOrdinal && !hasFirstOrdinal) {
    return legacyBareStableViewIdMessage(query);
  }
  if (keys.length > 1) {
    const suffixed = [...new Set(keys.filter((key) => key !== query))];
    return ambiguousStableViewIdMessage(query, query, keys.length, suffixed);
  }
  return null;
}
