/** Notification text matching, ranking, and action target selection. */

import { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import { boundsArea } from "../../../utils/bounds";
import { DefaultElementParser } from "../../utility/ElementParser";
import { rawResourceId } from "../../utility/elementProperties";
import { ResolverElementSelector } from "../../utility/ResolverElementSelector";
import { ignoreCasePolicy, INSPECT_INTENT } from "../../utility/SelectionPolicy";
import {
  getHierarchyRoots,
  getNodeProperties,
  matchesNotificationResourceId,
} from "../notificationHints";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { notificationSearchable } from "./dependencies";
import {
  type SystemTrayMatchKey,
  type SystemTrayMatchResult,
  type SystemTrayMatchType,
  type SystemTrayNotificationCandidate,
  type SystemTrayNotificationMatch,
  type SystemTrayTextMatch,
  collectNotificationCandidates,
  createSubHierarchy,
  extractNodeTextCandidates,
  getDirectChildNodes,
  getNotificationGroupChildRows,
  getNotificationGroupHeader,
  nodeIsNotificationGroup,
} from "./hierarchy";

interface SystemTrayElementMatch {
  text: string;
  matchType: SystemTrayMatchType;
  element: Element;
}

type NormalizedSearchText = { text: string; normalized: string };

const getNotificationCriteriaCount = (criteria: SystemTrayNotificationArgs): number => {
  return [criteria.title, criteria.body, criteria.appId, criteria.tapActionLabel].filter(Boolean)
    .length;
};

const buildNormalizedSearchText = (text?: string): NormalizedSearchText | null => {
  if (typeof text !== "string") {
    return null;
  }

  return { text, normalized: text.toLowerCase() };
};

const buildNormalizedSearchTexts = (texts: string[]): NormalizedSearchText[] => {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, normalized: text.toLowerCase() }));
};

const collectNodeSubtreeTextCandidates = (node: ViewHierarchyNode): string[] => {
  if (!node) {
    return [];
  }
  return [
    ...extractNodeTextCandidates(node),
    ...getDirectChildNodes(node).flatMap(collectNodeSubtreeTextCandidates),
  ];
};

const resolveMatchForSearchText = (
  nodeTextCandidatesLower: string[],
  searchText: NormalizedSearchText,
): SystemTrayTextMatch | null => {
  if (nodeTextCandidatesLower.some((text) => text === searchText.normalized)) {
    return { text: searchText.text, matchType: "exact" };
  }

  if (nodeTextCandidatesLower.some((text) => text.includes(searchText.normalized))) {
    return { text: searchText.text, matchType: "partial" };
  }

  return null;
};

const resolveMatchForSearchTexts = (
  nodeTextCandidatesLower: string[],
  searchTexts: NormalizedSearchText[],
): SystemTrayTextMatch | null => {
  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some((text) => text === searchText.normalized)) {
      return { text: searchText.text, matchType: "exact" };
    }
  }

  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some((text) => text.includes(searchText.normalized))) {
      return { text: searchText.text, matchType: "partial" };
    }
  }

  return null;
};

const mergeTextMatch = (
  currentMatch: SystemTrayTextMatch | undefined,
  nextMatch: SystemTrayTextMatch | undefined,
): SystemTrayTextMatch | undefined => {
  if (!nextMatch) {
    return currentMatch;
  }
  if (!currentMatch) {
    return nextMatch;
  }
  if (currentMatch.matchType === "exact") {
    return currentMatch;
  }
  if (nextMatch.matchType === "exact") {
    return nextMatch;
  }
  return currentMatch;
};

const mergeMatchMaps = (
  base: SystemTrayMatchResult["matches"],
  incoming: SystemTrayMatchResult["matches"],
): SystemTrayMatchResult["matches"] => {
  for (const [key, value] of Object.entries(incoming) as [
    SystemTrayMatchKey,
    SystemTrayTextMatch,
  ][]) {
    base[key] = mergeTextMatch(base[key], value);
  }
  return base;
};

const collectCompositeNotificationCandidates = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayNotificationCandidate[] => {
  const rootNodes = getHierarchyRoots(viewHierarchy);
  if (rootNodes.length === 0) {
    return [];
  }

  const titleText = buildNormalizedSearchText(criteria.title);
  const bodyText = buildNormalizedSearchText(criteria.body);
  const actionText = buildNormalizedSearchText(criteria.tapActionLabel);
  const appSearchTexts = criteria.appId
    ? buildNormalizedSearchTexts(appMatchTexts.length > 0 ? appMatchTexts : [criteria.appId])
    : [];

  const requiredKeys: SystemTrayMatchKey[] = [];
  if (titleText) {
    requiredKeys.push("title");
  }
  if (bodyText) {
    requiredKeys.push("body");
  }
  if (actionText) {
    requiredKeys.push("action");
  }
  if (criteria.appId) {
    requiredKeys.push("app");
  }

  if (requiredKeys.length === 0) {
    return [];
  }

  const candidates: SystemTrayNotificationCandidate[] = [];
  const visited = new Set<unknown>();
  const parser = new DefaultElementParser();

  const childRowMatchesContentCriteria = (childRow: ViewHierarchyNode): boolean => {
    const childTexts = collectNodeSubtreeTextCandidates(childRow).map((text) => text.toLowerCase());
    const matches = (searchText: NormalizedSearchText | null): boolean =>
      !searchText || childTexts.some((text) => text.includes(searchText.normalized));
    return matches(titleText) && matches(bodyText) && matches(actionText);
  };

  const resolveNodeMatches = (node: ViewHierarchyNode): SystemTrayMatchResult["matches"] => {
    const nodeTextCandidates = extractNodeTextCandidates(node);
    if (nodeTextCandidates.length === 0) {
      return {};
    }

    const nodeTextCandidatesLower = nodeTextCandidates.map((text) => text.toLowerCase());
    const matches: SystemTrayMatchResult["matches"] = {};

    if (titleText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, titleText);
      if (match) {
        matches.title = match;
      }
    }

    if (bodyText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, bodyText);
      if (match) {
        matches.body = match;
      }
    }

    if (actionText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, actionText);
      if (match) {
        matches.action = match;
      }
    }

    if (appSearchTexts.length > 0) {
      const match = resolveMatchForSearchTexts(nodeTextCandidatesLower, appSearchTexts);
      if (match) {
        matches.app = match;
      }
    }

    return matches;
  };

  const visitChildren = (
    node: ViewHierarchyNode,
    depth: number,
    currentGroupNode: ViewHierarchyNode | undefined,
    combinedMatches: SystemTrayMatchResult["matches"],
  ): { combinedMatches: SystemTrayMatchResult["matches"]; childHasAll: boolean } => {
    let childHasAll = false;
    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        const childResult = visit(child, depth + 1, currentGroupNode);
        combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
        if (childResult.hasAll) {
          childHasAll = true;
        }
      }
    } else if (children && typeof children === "object") {
      const childResult = visit(children, depth + 1, currentGroupNode);
      combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
      if (childResult.hasAll) {
        childHasAll = true;
      }
    }

    return { combinedMatches, childHasAll };
  };

  const visit = (
    node: ViewHierarchyNode,
    depth: number,
    groupNode?: ViewHierarchyNode,
  ): { matches: SystemTrayMatchResult["matches"]; hasAll: boolean } => {
    if (!node || visited.has(node)) {
      return { matches: {}, hasAll: false };
    }
    visited.add(node);

    const nodeMatches = resolveNodeMatches(node);
    const currentGroupNode = nodeIsNotificationGroup(node) ? node : groupNode;
    const { combinedMatches, childHasAll } = visitChildren(
      node,
      depth,
      currentGroupNode,
      nodeMatches,
    );

    const hasAll = requiredKeys.every((key) => Boolean(combinedMatches[key]));
    if (hasAll && !childHasAll) {
      const childRow = currentGroupNode
        ? getNotificationGroupChildRows(currentGroupNode).find(childRowMatchesContentCriteria)
        : undefined;
      const element = parser.parseNodeBounds(childRow ?? node) ?? undefined;
      candidates.push({ node, depth, element, groupNode: currentGroupNode });
    }

    return { matches: combinedMatches, hasAll };
  };

  for (const rootNode of rootNodes) {
    visit(rootNode, 0);
  }

  return candidates;
};

// Existence checks: `inspect` matches inert labels and collapsed-group children
// (visible-to-user false); the default tap intent drops text with no tappable owner (#10269).
const hasTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
  partialMatch: boolean,
): boolean =>
  selector.select(
    viewHierarchy,
    { text },
    {
      ...ignoreCasePolicy(partialMatch),
      ...INSPECT_INTENT,
    },
  ).totalMatches > 0;

const findTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
): SystemTrayTextMatch | null => {
  if (hasTextMatch(selector, viewHierarchy, text, false)) {
    return { text, matchType: "exact" };
  }

  if (hasTextMatch(selector, viewHierarchy, text, true)) {
    return { text, matchType: "partial" };
  }

  return null;
};

const findFirstTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  texts: string[],
): SystemTrayTextMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
  for (const text of candidates) {
    if (hasTextMatch(selector, viewHierarchy, text, false)) {
      return { text, matchType: "exact" };
    }
  }

  for (const text of candidates) {
    if (hasTextMatch(selector, viewHierarchy, text, true)) {
      return { text, matchType: "partial" };
    }
  }

  return null;
};

// Tap and swipe targets both resolve with `inspect`, which returns the matched label
// itself. The tap intent would find nothing in the shade: CtrlProxy captures carry no
// click affordance on notification rows or their labels, while a tap on the label
// still reaches the row's content intent on the device (#10269).
const findFirstElementMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  texts: string[],
): SystemTrayElementMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
  for (const matchType of ["exact", "partial"] as const) {
    for (const text of candidates) {
      const { element } = selector.select(
        viewHierarchy,
        { text },
        {
          ...ignoreCasePolicy(matchType === "partial"),
          ...INSPECT_INTENT,
        },
      );
      if (element) {
        return { text, matchType, element };
      }
    }
  }

  return null;
};

const findElementMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
): SystemTrayElementMatch | null => findFirstElementMatch(selector, viewHierarchy, [text]);

const buildNotificationMatch = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayMatchResult => {
  const selector = new ResolverElementSelector();
  const matches: SystemTrayMatchResult["matches"] = {};
  let matched = true;

  if (criteria.title) {
    const titleMatch = findTextMatch(selector, viewHierarchy, criteria.title);
    if (!titleMatch) {
      matched = false;
    } else {
      matches.title = titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findTextMatch(selector, viewHierarchy, criteria.body);
    if (!bodyMatch) {
      matched = false;
    } else {
      matches.body = bodyMatch;
    }
  }

  if (criteria.tapActionLabel) {
    const actionMatch = findTextMatch(selector, viewHierarchy, criteria.tapActionLabel);
    if (!actionMatch) {
      matched = false;
    } else {
      matches.action = actionMatch;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstTextMatch(selector, viewHierarchy, appMatchTexts);
    if (!appMatch) {
      matched = false;
    } else {
      matches.app = appMatch;
    }
  }

  return { matched, matches };
};

const getMatchCounts = (
  matches: SystemTrayMatchResult["matches"],
): { exact: number; partial: number } => {
  const values = Object.values(matches);
  let exact = 0;
  let partial = 0;
  for (const match of values) {
    if (!match) {
      continue;
    }
    if (match.matchType === "exact") {
      exact += 1;
    } else {
      partial += 1;
    }
  }
  return { exact, partial };
};

const getCandidateArea = (candidate: SystemTrayNotificationCandidate): number => {
  const bounds = candidate.element?.bounds;
  if (!bounds) {
    return 0;
  }
  return boundsArea(bounds);
};

const CANDIDATE_NO_BOUNDS_TOP_Y = Infinity;

const getCandidateTopY = (candidate: SystemTrayNotificationCandidate): number => {
  return candidate.element?.bounds?.top ?? CANDIDATE_NO_BOUNDS_TOP_Y;
};

const selectBestNotificationMatch = (
  matches: SystemTrayNotificationMatch[],
): SystemTrayNotificationMatch | null => {
  if (matches.length === 0) {
    return null;
  }

  return matches.slice().sort((left, right) => {
    const leftCounts = getMatchCounts(left.match.matches);
    const rightCounts = getMatchCounts(right.match.matches);
    if (leftCounts.exact !== rightCounts.exact) {
      return rightCounts.exact - leftCounts.exact;
    }
    if (leftCounts.partial !== rightCounts.partial) {
      return rightCounts.partial - leftCounts.partial;
    }
    const windowDelta = (left.candidate.windowRank ?? 0) - (right.candidate.windowRank ?? 0);
    if (windowDelta !== 0) {
      return windowDelta;
    }
    // Prefer topmost notification (most recent in Android shade)
    const leftTop = getCandidateTopY(left.candidate);
    const rightTop = getCandidateTopY(right.candidate);
    if (leftTop !== rightTop) {
      return leftTop - rightTop;
    }
    const leftArea = getCandidateArea(left.candidate);
    const rightArea = getCandidateArea(right.candidate);
    if (leftArea !== rightArea) {
      return rightArea - leftArea;
    }
    return left.candidate.depth - right.candidate.depth;
  })[0];
};

const buildNotificationCandidateMatch = (
  candidate: SystemTrayNotificationCandidate,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayMatchResult => {
  const subHierarchy = createSubHierarchy(candidate.node);
  const direct = buildNotificationMatch(subHierarchy, criteria, appMatchTexts);
  if (direct.matched || !candidate.groupNode || !criteria.appId) {
    return direct;
  }
  const header = getNotificationGroupHeader(candidate.groupNode);
  if (!header) {
    return direct;
  }
  const content = buildNotificationMatch(subHierarchy, { ...criteria, appId: undefined }, []);
  const app = buildNotificationMatch(
    createSubHierarchy(header),
    { appId: criteria.appId },
    appMatchTexts,
  );
  return content.matched && app.matched
    ? { matched: true, matches: { ...content.matches, ...app.matches } }
    : direct;
};

const nodeIsNotificationStackScroller = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  const resourceId = rawResourceId(props);
  return matchesNotificationResourceId(resourceId, "notification_stack_scroller");
};

export const findNotificationMatches = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayNotificationMatch[] => {
  const windowRanks = new Map<unknown, number>();
  for (const entry of notificationSearchable.project(viewHierarchy)) {
    windowRanks.set(
      entry.source,
      Math.min(windowRanks.get(entry.source) ?? Infinity, entry.windowRank),
    );
  }
  const parser = new DefaultElementParser();
  const candidates = collectNotificationCandidates(viewHierarchy);
  const criteriaCount = getNotificationCriteriaCount(criteria);
  const matchCandidates = (
    candidateList: SystemTrayNotificationCandidate[],
  ): SystemTrayNotificationMatch[] => {
    return candidateList
      .map((candidate) => {
        const subHierarchy = createSubHierarchy(candidate.node);
        const match = buildNotificationCandidateMatch(candidate, criteria, appMatchTexts);
        return {
          candidate: { ...candidate, windowRank: windowRanks.get(candidate.node) ?? 0 },
          match,
          subHierarchy,
        };
      })
      .filter((entry) => entry.match.matched);
  };

  let matches = matchCandidates(candidates);
  if (matches.length > 0) {
    return matches;
  }

  let fallbackCandidates: SystemTrayNotificationCandidate[] = [];
  if (criteriaCount <= 1) {
    if (candidates.length === 0) {
      fallbackCandidates = getHierarchyRoots(viewHierarchy).map((node) => ({
        node,
        depth: 0,
        element: parser.parseNodeBounds(node) ?? undefined,
      }));
    }
  } else {
    fallbackCandidates = collectCompositeNotificationCandidates(
      viewHierarchy,
      criteria,
      appMatchTexts,
    ).filter(
      (candidate) => candidates.length === 0 || !nodeIsNotificationStackScroller(candidate.node),
    );
  }

  if (fallbackCandidates.length === 0) {
    return matches;
  }

  matches = matchCandidates(fallbackCandidates);
  return matches;
};

export const findBestNotificationMatch = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayNotificationMatch | null => {
  const matches = findNotificationMatches(viewHierarchy, criteria, appMatchTexts);
  return selectBestNotificationMatch(matches);
};

export const resolveNotificationTapElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
): SystemTrayElementMatch | null => {
  const selector = new ResolverElementSelector();
  const subHierarchy = match.subHierarchy;

  if (criteria.tapActionLabel) {
    const actionMatch = findElementMatch(selector, subHierarchy, criteria.tapActionLabel);
    if (actionMatch) {
      return actionMatch;
    }
  }

  if (criteria.title) {
    const titleMatch = findElementMatch(selector, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(selector, subHierarchy, criteria.body);
    if (bodyMatch) {
      return bodyMatch;
    }
  }

  return null;
};

export const resolveNotificationSwipeElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): Element | null => {
  if (match.candidate.element) {
    return match.candidate.element;
  }

  const selector = new ResolverElementSelector();
  const subHierarchy = match.subHierarchy;

  if (criteria.title) {
    const titleMatch = findElementMatch(selector, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch.element;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(selector, subHierarchy, criteria.body);
    if (bodyMatch) {
      return bodyMatch.element;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstElementMatch(selector, subHierarchy, appMatchTexts);
    if (appMatch) {
      return appMatch.element;
    }
  }

  return null;
};
