import { Element } from "../../models/Element";
import { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { TextMatcher } from "../../utils/interfaces/TextMatcher";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementParser } from "./ElementParser";
import { DefaultTextMatcher, normalizeQuotes } from "./TextMatcher";
import { ANDROID_INPUT_CLASSES, isClickableElementProperties } from "../../utils/elementProperties";
import {
  STABLE_VIEW_ID_HASH_LENGTH,
  STABLE_VIEW_ID_PREFIX,
} from "../observe/android/StableNodeIdentity";
import { ActionableError } from "../../models/ActionableError";

/**
 * `assignStableViewIds` disambiguates content-identical duplicate nodes with an
 * ordinal `-<k>` suffix (`s-<hash>-1`, `s-<hash>-2`, ...) assigned by document
 * order AT CAPTURE TIME (`StableNodeIdentity.ts`) - EVERY member of a duplicate
 * group is suffixed, including the first (`-1`), and the bare, un-suffixed
 * `s-<hash>` is emitted only for a hash that is UNIQUE in the capture (issue
 * #6229). The ordinal forms are still capture-local whenever a duplicate
 * exists: an insert or reorder between the capture an id was observed from and
 * the fresh capture a later `tapOn`/`inputText` resolves it against can shift
 * which node an existing `-<k>` lands on - silently resolving to the WRONG
 * node rather than the one the caller meant (issue #6218 review thread
 * PRRT_kwDOP-GF5M6foer0, follow-up PRRT_kwDOP-GF5M6fomf-). The bare form, by
 * contrast, now means "this content was unique when observed", so it cannot be
 * silently reassigned to a since-removed peer (issue #6229).
 *
 * This pattern requires the producer's EXACT shape - the `s-` prefix plus
 * exactly `STABLE_VIEW_ID_HASH_LENGTH` hex characters, with an optional
 * `-<k>` ordinal - so a real, resource-id-backed `view-id` that merely starts
 * with `s-` (e.g. a bare Compose testTag like `s-a` / `s-a-2`) is never
 * misclassified as synthetic (review thread PRRT_kwDOP-GF5M6fomgA).
 */
const SYNTHETIC_STABLE_VIEW_ID_PATTERN = new RegExp(
  `^(${STABLE_VIEW_ID_PREFIX}[0-9a-f]{${STABLE_VIEW_ID_HASH_LENGTH}})(?:-\\d+)?$`,
);

/**
 * The base id (`s-<hash>`, un-suffixed) for a synthetic stable id, whether
 * `id` itself is the bare first-occurrence form or an ordinal-suffixed
 * duplicate. Returns null when `id` does not match the producer's exact
 * shape - including a real `view-id` that only superficially resembles one.
 */
function syntheticStableViewIdBase(id: string): string | null {
  const match = SYNTHETIC_STABLE_VIEW_ID_PATTERN.exec(id);
  return match ? match[1] : null;
}

/** True when `viewId` is a synthetic id (bare or ordinal-suffixed) sharing `base`. */
function sharesStableViewIdBase(viewId: string, base: string): boolean {
  return syntheticStableViewIdBase(viewId) === base;
}

/**
 * Match a selector against a node's REAL `resource-id` field only - never
 * `view-id`. Callers use this alone (instead of
 * `matchesResourceIdOrStableViewId`) once they have established that a real
 * resource-id match exists somewhere in the active search scope, so the
 * synthetic view-id fallback can be disabled entirely for that selector
 * rather than unioned with it (review threads PRRT_kwDOP-GF5M6fo13g,
 * PRRT_kwDOP-GF5M6fo2Iq).
 */
function matchesResourceIdFieldOnly(
  nodeProperties: Record<string, unknown>,
  resourceId: string,
  bareResourceId: string | null,
  partialMatch: boolean,
): boolean {
  const nodeResourceId = nodeProperties["resource-id"];
  if (typeof nodeResourceId !== "string") {
    return false;
  }
  return (
    nodeResourceId === resourceId ||
    (bareResourceId !== null && nodeResourceId === bareResourceId) ||
    (partialMatch && nodeResourceId.toLowerCase().includes(resourceId.toLowerCase()))
  );
}

/**
 * `resourceId`/`elementId` selectors carry an `s-<hash>` content-derived
 * stable id (`assignStableViewIds`, issue #3228) for nodes with no real
 * `resource-id` — the skeleton projection emits exactly that value as
 * `elementId` (`SkeletonProjection.deriveId`). Resolve it against the node's
 * `view-id` field, not `resource-id`, so a skeleton id round-trips back to
 * its element (issue #6218). Exact match only: the hash carries no partial-
 * or bare-suffix semantics the way a `pkg:id/name` resource-id does. The
 * view-id fallback is gated on the selector matching the producer's strict
 * synthetic shape (`syntheticStableViewIdBase`), not merely the `s-` prefix,
 * so a real id like `view-id: "s-a"` is treated as a plain resource-id, never
 * as a synthetic ordinal (review thread PRRT_kwDOP-GF5M6fo2Ip). Callers that
 * have already established a real resource-id match exists in scope should
 * use `matchesResourceIdFieldOnly` instead of this function, which unions
 * both kinds of match and is therefore only safe to use when no such
 * precedence question is in play.
 */
function matchesResourceIdOrStableViewId(
  nodeProperties: Record<string, unknown>,
  resourceId: string,
  bareResourceId: string | null,
  partialMatch: boolean,
): boolean {
  if (matchesResourceIdFieldOnly(nodeProperties, resourceId, bareResourceId, partialMatch)) {
    return true;
  }
  if (syntheticStableViewIdBase(resourceId) !== null) {
    const nodeViewId = nodeProperties["view-id"];
    if (typeof nodeViewId === "string" && nodeViewId === resourceId) {
      return true;
    }
  }
  return false;
}

/**
 * Handles searching and selection of elements in view hierarchy
 */
export class DefaultElementFinder implements ElementFinder {
  private parser: ElementParser;
  private textMatcher: TextMatcher;

  constructor(
    parser: ElementParser = new DefaultElementParser(),
    textMatcher: TextMatcher = new DefaultTextMatcher(),
  ) {
    this.parser = parser;
    this.textMatcher = textMatcher;
  }

  hasContainerElement(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string },
  ): boolean {
    if (!viewHierarchy || !container) {
      return false;
    }

    return this.findContainerNodeInternal(viewHierarchy, container) !== null;
  }

  private findContainerNodeInRoots(
    rootNodes: ViewHierarchyNode[],
    container: { elementId?: string; text?: string },
    matchesContainerText: ((input?: string) => boolean) | null,
    preferResourceIdOnly: boolean = false,
  ): ViewHierarchyNode | null {
    for (const rootNode of rootNodes) {
      let containerNode: ViewHierarchyNode | null = null;
      this.parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
        if (containerNode) {
          return; // Already found
        }

        const nodeProperties = this.parser.extractNodeProperties(node);
        const nodeText = nodeProperties.text;
        const nodeContentDesc = nodeProperties["content-desc"];
        const nodeIosLabel = nodeProperties["ios-accessibility-label"];

        const elementIdMatches =
          container.elementId &&
          (preferResourceIdOnly
            ? matchesResourceIdFieldOnly(nodeProperties, container.elementId, null, false)
            : matchesResourceIdOrStableViewId(nodeProperties, container.elementId, null, false));

        if (elementIdMatches) {
          containerNode = node;
          return;
        }

        if (
          matchesContainerText &&
          ((typeof nodeText === "string" && matchesContainerText(nodeText)) ||
            (typeof nodeContentDesc === "string" && matchesContainerText(nodeContentDesc)) ||
            (typeof nodeIosLabel === "string" && matchesContainerText(nodeIosLabel)))
        ) {
          containerNode = node;
        }
      });

      if (containerNode) {
        return containerNode;
      }
    }

    return null;
  }

  private findContainerNodeInternal(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null {
    if (!viewHierarchy || !container) {
      return null;
    }

    let preferResourceIdOnly = false;
    if (container.elementId) {
      // A container selector has no enclosing scope of its own to resolve
      // first, so it is always checked against the whole capture.
      const fullCaptureRoots = this.collectFullCaptureSearchRoots(viewHierarchy);
      this.assertStableViewIdSelectorNotAmbiguous(
        fullCaptureRoots,
        fullCaptureRoots,
        container.elementId,
      );
      // A real resource-id match anywhere in the capture always wins over a
      // synthetic view-id match - never unioned with one, and never shadowed
      // by a stable-id match found in an earlier-priority scope (review
      // threads PRRT_kwDOP-GF5M6fo13g, PRRT_kwDOP-GF5M6fo2Iq).
      preferResourceIdOnly = this.hasExactResourceIdFieldMatch(
        fullCaptureRoots,
        container.elementId,
      );
    }

    const matchesContainerText = container.text
      ? this.textMatcher.createTextMatcher(container.text, true, false)
      : null;
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const containerInMain = this.findContainerNodeInRoots(
      rootNodes,
      container,
      matchesContainerText,
      preferResourceIdOnly,
    );
    if (containerInMain) {
      return containerInMain;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const containerInWindow = this.findContainerNodeInRoots(
        windowRoots,
        container,
        matchesContainerText,
        preferResourceIdOnly,
      );
      if (containerInWindow) {
        return containerInWindow;
      }
    }

    return null;
  }

  private sortElementsByArea(elements: Element[]): void {
    elements.sort((a, b) => {
      const aArea = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
      const bArea = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
      return aArea - bArea;
    });
  }

  private collectTextMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    text: string,
    matchesText: (input?: string) => boolean,
    sortByArea: boolean = true,
  ): { exactMatches: Element[]; partialMatches: Element[] } {
    const partialMatches: Element[] = [];
    const exactMatches: Element[] = [];

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        logger.debug(
          `[Element] node: ${nodeProperties["text"]} ${nodeProperties["content-desc"]} ${nodeProperties["class"]}`,
        );

        // Check text attribute
        if (
          nodeProperties.text &&
          typeof nodeProperties.text === "string" &&
          matchesText(nodeProperties.text)
        ) {
          logger.debug("[Element] Matches text property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (normalizeQuotes(nodeProperties.text) === normalizeQuotes(text)) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          nodeProperties["content-desc"] &&
          typeof nodeProperties["content-desc"] === "string" &&
          matchesText(nodeProperties["content-desc"])
        ) {
          logger.debug("[Element] Matches content-desc property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (normalizeQuotes(nodeProperties["content-desc"]) === normalizeQuotes(text)) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          nodeProperties["ios-accessibility-label"] &&
          typeof nodeProperties["ios-accessibility-label"] === "string" &&
          matchesText(nodeProperties["ios-accessibility-label"])
        ) {
          logger.debug("[Element] Matches ios-accessibility-label property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (
              normalizeQuotes(nodeProperties["ios-accessibility-label"]) === normalizeQuotes(text)
            ) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          matchesText(nodeProperties.text || nodeProperties["content-desc"] || "") &&
          (nodeProperties["ios-role"] === "AXButton" ||
            nodeProperties.class === "Button" ||
            this.isClickableNode(nodeProperties))
        ) {
          logger.debug("[Element] Matches clickable element with text");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            partialMatches.push(parsedNode);
          }
        } else {
          logger.debug(`[Element] No match found in properties`);
        }
      });
    }

    if (sortByArea && exactMatches.length > 0) {
      this.sortElementsByArea(exactMatches);
    }
    if (sortByArea && partialMatches.length > 0) {
      this.sortElementsByArea(partialMatches);
    }

    return { exactMatches, partialMatches };
  }

  private collectResourceIdMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    resourceId: string,
    partialMatch: boolean,
    sortByArea: boolean = true,
    resourceIdFieldOnly: boolean = false,
  ): Element[] {
    const matches: Element[] = [];
    // Compose semantics (Modifier.testTag) surface via AccessibilityNodeInfo.viewIdResourceName
    // WITHOUT a package qualifier, unlike traditional View resource IDs which are always
    // reported as "pkg:id/name". A caller passing the fully-qualified form (the common case,
    // since that's what every other resource ID in the hierarchy looks like) would otherwise
    // never match a Compose-sourced node. This is not a fuzzy/partial match - the bare name is
    // the node's real, exact reported ID - so it applies regardless of the partialMatch flag.
    const idSeparatorIndex = resourceId.lastIndexOf("/");
    const bareResourceId = idSeparatorIndex >= 0 ? resourceId.slice(idSeparatorIndex + 1) : null;

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        // `resourceIdFieldOnly` disables the synthetic view-id fallback
        // entirely once a real resource-id match has been established
        // elsewhere in the active scope (review threads
        // PRRT_kwDOP-GF5M6fo13g, PRRT_kwDOP-GF5M6fo2Iq) - a real match must
        // never be unioned with, or out-competed by, a synthetic one.
        const isMatch = resourceIdFieldOnly
          ? matchesResourceIdFieldOnly(nodeProperties, resourceId, bareResourceId, partialMatch)
          : matchesResourceIdOrStableViewId(
              nodeProperties,
              resourceId,
              bareResourceId,
              partialMatch,
            );
        if (isMatch) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            matches.push(parsedNode);
          }
        }
      });
    }

    if (sortByArea && matches.length > 0) {
      this.sortElementsByArea(matches);
    }

    return matches;
  }

  private collectTestTagMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    testTag: string,
    sortByArea: boolean = true,
  ): Element[] {
    const matches: Element[] = [];

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties["test-tag"] === testTag) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            matches.push(parsedNode);
          }
        }
      });
    }

    if (sortByArea && matches.length > 0) {
      this.sortElementsByArea(matches);
    }

    return matches;
  }

  private findScrollableContainerInRoots(rootNodes: ViewHierarchyNode[]): Element | null {
    for (const rootNode of rootNodes) {
      let foundScrollable: Element | null = null;
      this.parser.traverseNode(rootNode, (node: any) => {
        if (foundScrollable) {
          return;
        } // Already found one
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            foundScrollable = parsedNode;
          }
        }
      });
      if (foundScrollable) {
        return foundScrollable;
      }
    }

    return null;
  }

  private findFocusedTextInputInRoots(
    rootNodes: ViewHierarchyNode[],
    ANDROID_INPUT_CLASSES: string[],
  ): Element | null {
    for (const rootNode of rootNodes) {
      let foundElement: Element | null = null;
      this.parser.traverseNode(rootNode, (node: any) => {
        if (foundElement) {
          return;
        } // Already found one

        const nodeProperties = this.parser.extractNodeProperties(node);
        // Check for both 'class' and 'className' property names
        const nodeClass = nodeProperties.class || nodeProperties.className;
        if (
          (nodeProperties.focused === "true" || nodeProperties.focused === true) &&
          nodeClass &&
          ANDROID_INPUT_CLASSES.some((cls) => nodeClass.includes(cls))
        ) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            foundElement = parsedNode;
          }
        }
      });

      if (foundElement) {
        return foundElement;
      }
    }

    return null;
  }

  private isClickableNode(props: Record<string, unknown>): boolean {
    return isClickableElementProperties(props);
  }

  /**
   * The full set of search roots for a capture — main hierarchy roots plus
   * every window's roots. `assertStableViewIdSelectorNotAmbiguous` always
   * scopes its duplicate count to this whole-capture set (never a single
   * resolved container), so it matches the scope `assignStableViewIds` assigns
   * ordinals over (issue #6229 review thread PRRT_kwDOP-GF5M6f1gS0).
   */
  private collectFullCaptureSearchRoots(viewHierarchy: ViewHierarchyResult): ViewHierarchyNode[] {
    const roots = [...this.parser.extractRootNodes(viewHierarchy)];
    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      roots.push(...windowRoots);
    }
    return roots;
  }

  /**
   * Count nodes within `searchRoots` whose `view-id` is `base` or an
   * ordinal-suffixed duplicate of it. Used to decide whether a synthetic
   * `s-<hash>(-<k>)?` selector is safe to trust (see
   * `assertStableViewIdSelectorNotAmbiguous`). Callers pass the WHOLE-capture
   * roots — the same scope `assignStableViewIds` assigns ordinals over — so a
   * content-identical peer OUTSIDE a selected container still counts, because a
   * cross-capture removal can globally re-ordinal the id onto that peer.
   */
  private countNodesSharingStableViewIdBase(
    searchRoots: ViewHierarchyNode[],
    base: string,
  ): number {
    let count = 0;
    for (const root of searchRoots) {
      this.parser.traverseNode(root, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        const viewId = nodeProperties["view-id"];
        if (typeof viewId === "string" && sharesStableViewIdBase(viewId, base)) {
          count++;
        }
      });
    }
    return count;
  }

  /**
   * True when some node within `searchRoots` carries `id` as its REAL
   * `resource-id` field (not merely a `view-id` that happens to look
   * synthetic-shaped). A real resource-id is never subject to
   * `assignStableViewIds`' ordinal semantics, so it must win over a
   * synthetic-ordinal interpretation of the same string (review thread
   * PRRT_kwDOP-GF5M6fomgA) even in the astronomically unlikely case a real id
   * collides with the producer's exact `s-<16 hex>(-<k>)?` shape.
   */
  private hasExactResourceIdFieldMatch(searchRoots: ViewHierarchyNode[], id: string): boolean {
    let found = false;
    for (const root of searchRoots) {
      if (found) {
        break;
      }
      this.parser.traverseNode(root, (node: any) => {
        if (found) {
          return;
        }
        const resourceId = this.parser.extractNodeProperties(node)["resource-id"];
        if (typeof resourceId === "string" && resourceId === id) {
          found = true;
        }
      });
    }
    return found;
  }

  /**
   * Detect the pre-#6229 duplicate encoding: its first member used the bare
   * `s-<hash>` id while later members started at `-2`. The current producer
   * assigns `-1` to every first duplicate, so a bare member plus a later
   * ordinal but no `-1` is a recognizable legacy (or malformed) family.
   */
  private hasLegacyBareStableViewIdFamily(searchRoots: ViewHierarchyNode[], base: string): boolean {
    let hasBare = false;
    let hasFirstOrdinal = false;
    let hasLaterOrdinal = false;
    for (const root of searchRoots) {
      this.parser.traverseNode(root, (node: any) => {
        const viewId = this.parser.extractNodeProperties(node)["view-id"];
        if (viewId === base) {
          hasBare = true;
        } else if (viewId === `${base}-1`) {
          hasFirstOrdinal = true;
        } else if (typeof viewId === "string" && sharesStableViewIdBase(viewId, base)) {
          hasLaterOrdinal = true;
        }
      });
    }
    return hasBare && hasLaterOrdinal && !hasFirstOrdinal;
  }

  /**
   * Reject a synthetic stable-view-id selector (`s-<hash>` bare OR
   * `s-<hash>-<k>` ordinal-suffixed) when MORE THAN ONE node in the WHOLE
   * capture shares its base content hash — i.e. it has content-identical peers,
   * so which node holds the bare id vs. which ordinal is load-bearing /
   * capture-local rather than moot. A selector whose base hash is unique in the
   * capture is left alone, and so is a real `resource-id`-backed id that merely
   * resembles the synthetic shape (issue #6218 review threads
   * PRRT_kwDOP-GF5M6foer0, PRRT_kwDOP-GF5M6fomf-, PRRT_kwDOP-GF5M6fomgA).
   * Rejecting is correct here: a wrong tap is worse than a clear failure
   * telling the caller to use a more specific selector.
   *
   * `searchRoots` MUST be the WHOLE-capture roots — the SAME scope
   * `assignStableViewIds` assigns duplicate-group ordinals over (issue #6229,
   * review thread PRRT_kwDOP-GF5M6f1gS0). Scoping this count to a selected
   * container instead was unsound: the ordinal `-<k>` suffix is a function of
   * GLOBAL document order, so a content-identical peer OUTSIDE the container
   * still makes an in-container ordinal capture-local. With `[A, B]` in
   * container `c1` and identical `C` in `c2`, the caller observes `A` as
   * `s-H-1`; remove `A` and global re-ordinaling makes surviving `B` the new
   * `s-H-1`. A container-scoped count would see only one `s-H`-family node in
   * `c1` (just `B`) and wave the stale selector through, silently retargeting
   * `B`. Counting over the whole capture sees `B` AND `C`, so the guard rejects
   * it as ambiguous. The cost is deliberate: a globally-ambiguous ordinal is no
   * longer rescued by a `container` selector even when the container isolates a
   * single peer, because a single fresh capture cannot distinguish that layout
   * from a post-removal reassignment — the caller must use text/content-desc/
   * bounds instead. A bare `s-H` is globally unique by construction, so it still
   * resolves (with or without a container) untouched.
   *
   * The since-removed-peer retarget (issue #6229, review threads
   * PRRT_kwDOP-GF5M6fouI8, PRRT_kwDOP-GF5M6f1gS0) is closed both at the PRODUCER
   * and here. `assignStableViewIds` no longer hands the first of a
   * content-identical duplicate group the bare `s-H`; every member takes a
   * `-<k>` ordinal (the first `-1`), and the bare form is reserved for content
   * that was unique when observed. So a caller who observed `A` in a `[A, B]`
   * group holds `s-H-1`, never bare `s-H`. If `A` is then removed and `B`
   * becomes the sole survivor, `B` is reassigned the bare `s-H` (now unique) —
   * which no longer equals the caller's `s-H-1`, so resolution MISSES instead of
   * silently landing on `B`. While ≥2 content-identical peers still remain
   * anywhere in the capture, `duplicateCount > 1` below rejects the stale
   * selector as ambiguous. The residual gap this current-capture-only check
   * still cannot see is narrower: a bare id whose once-unique node was removed
   * and independently REPLACED by a brand-new content-identical node (still
   * exactly one in the fresh capture) — closing that needs capture-origin
   * provenance (which generation/session an id was observed in), a design change
   * spanning the observe layer and this finder.
   *
   * KNOWN LIMITATION (issue #6230, review thread PRRT_kwDOP-GF5M6fo-Pb): a
   * synthetic id is a Merkle hash over a node's OWN content fields plus every
   * DESCENDANT's content hash (`StableNodeIdentity.ts`), so a still-present,
   * otherwise-unchanged ancestor's id changes whenever any descendant's
   * `text`/`content-desc` changes between captures - e.g. a live timer child
   * ticking "1 second" → "2 seconds" changes its row's id from one capture to
   * the next. The exact-match lookup below then finds nothing for the id a
   * caller observed a moment earlier, even though the intended control is
   * still on screen (a miss, not a mis-tap). This is the counterpart of the
   * #6229 removal case - both are inherent to a pure content hash, which is
   * stable only while content is stable - and needs the same class of fix:
   * structural/positional identity or capture-origin provenance, not a
   * change to the current-capture-only matching done here.
   *
   * `activeScopeRoots` and `fullCaptureRoots` are deliberately DIFFERENT scopes
   * (issue #6229 review thread PRRT_kwDOP-GF5M6f2X6J): the real-`resource-id`
   * bypass (`hasExactResourceIdFieldMatch` below) must stay scoped to the
   * active selector scope (a resolved container's subtree, when one is given -
   * else the whole capture), exactly like the resource-id PREFERENCE callers
   * compute alongside this call. Widening the bypass to the whole capture lets
   * a real `resource-id` match OUTSIDE a selected container suppress the
   * ambiguity error for a synthetic ordinal that is genuinely ambiguous
   * INSIDE the container - the caller then falls through to a synthetic-id
   * match there and can silently resolve the wrong peer. The duplicate COUNT
   * must stay on `fullCaptureRoots` regardless (see above): only the early
   * "a real id already backs this" exit needs the narrower scope.
   */
  private assertStableViewIdSelectorNotAmbiguous(
    activeScopeRoots: ViewHierarchyNode[],
    fullCaptureRoots: ViewHierarchyNode[],
    id: string,
  ): void {
    const base = syntheticStableViewIdBase(id);
    if (!base) {
      return;
    }
    if (this.hasExactResourceIdFieldMatch(activeScopeRoots, id)) {
      return;
    }
    if (id === base && this.hasLegacyBareStableViewIdFamily(fullCaptureRoots, base)) {
      throw new ActionableError(
        `Skeleton element id "${id}" uses the legacy bare duplicate encoding in this capture. ` +
          "Re-observe the screen and use a current selector; legacy bare stable ids cannot safely " +
          "identify a content-identical element.",
      );
    }
    const duplicateCount = this.countNodesSharingStableViewIdBase(fullCaptureRoots, base);
    if (duplicateCount > 1) {
      throw new ActionableError(
        `Skeleton element id "${id}" is ambiguous in the current capture: ${duplicateCount} ` +
          `content-identical elements share stable id "${base}", and which of them holds the ` +
          'bare id vs. an "-N" ordinal suffix is assigned by document order at capture time. An ' +
          "element insert or reorder since this id was observed can shift which element it now " +
          "points to, so resolving it here could silently act on the wrong element. Use a more " +
          "specific selector (text, content-desc, or bounds) instead.",
      );
    }
  }

  private rankTextMatches(matches: Element[]): Element[] {
    matches.sort((a, b) => Number(this.isClickableNode(b)) - Number(this.isClickableNode(a)));
    return matches;
  }

  private isCollectionNode(props: Record<string, unknown>): boolean {
    const className = typeof props.class === "string" ? props.class : "";
    const scrollable = props.scrollable === "true" || props.scrollable === true;
    return (
      scrollable ||
      className.includes("RecyclerView") ||
      className.includes("ListView") ||
      className.includes("ScrollView") ||
      className.includes("CollectionView") ||
      className.includes("TableView")
    );
  }

  /**
   * Find elements in the view hierarchy that match the specified text
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to use partial matching (substring containment)
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of matching elements
   */
  findElementsByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = true,
    caseSensitive: boolean = false,
    preserveTraversalOrder: boolean = false,
    includeWindows: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, partialMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const selectMatches = (matches: {
      exactMatches: Element[];
      partialMatches: Element[];
    }): Element[] => {
      return matches.exactMatches.length > 0 ? matches.exactMatches : matches.partialMatches;
    };

    if (containerNode) {
      return selectMatches(
        this.collectTextMatchesInRoots([containerNode], text, matchesText, !preserveTraversalOrder),
      );
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectTextMatchesInRoots(
      rootNodes,
      text,
      matchesText,
      !preserveTraversalOrder,
    );
    if (!includeWindows) {
      const selectedMainMatches = selectMatches(mainMatches);
      if (selectedMainMatches.length > 0) {
        return selectedMainMatches;
      }
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    const windowMatches = windowRootGroups.map((windowRoots) => {
      return this.collectTextMatchesInRoots(
        windowRoots,
        text,
        matchesText,
        !preserveTraversalOrder,
      );
    });

    if (!includeWindows) {
      for (const matches of windowMatches) {
        const selectedWindowMatches = selectMatches(matches);
        if (selectedWindowMatches.length > 0) {
          return selectedWindowMatches;
        }
      }
      return [];
    }

    if (preserveTraversalOrder) {
      const exactMatches = [mainMatches, ...windowMatches].flatMap(
        (matches) => matches.exactMatches,
      );
      if (exactMatches.length > 0) {
        return exactMatches;
      }
      return [mainMatches, ...windowMatches].flatMap((matches) => matches.partialMatches);
    }

    const matchesByWindowOrder = [...windowMatches, mainMatches];
    const hasExactMatches = matchesByWindowOrder.some((matches) => matches.exactMatches.length > 0);
    return matchesByWindowOrder.flatMap((matches) =>
      this.rankTextMatches(hasExactMatches ? matches.exactMatches : matches.partialMatches),
    );
  }

  /**
   * Find an element in the view hierarchy that matches the specified text
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to use partial matching (substring containment)
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns The found element or null
   */
  findElementByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element | null {
    const matches = this.findElementsByText(
      viewHierarchy,
      text,
      container,
      partialMatch,
      caseSensitive,
    );
    return matches[0] ?? null;
  }

  /**
   * Find elements by resource ID
   * @param viewHierarchy - The view hierarchy to search
   * @param resourceId - Resource ID to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to allow partial ID matching
   * @returns Array of matching elements
   */
  findElementsByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
    preserveTraversalOrder: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !resourceId) {
      return [];
    }

    // Resolve the container FIRST when one is given, so the ambiguity check
    // below can be scoped to just its subtree - a content-identical duplicate
    // OUTSIDE the named container must not block (or misdirect) resolution
    // of a uniquely-identified control inside it (review thread
    // PRRT_kwDOP-GF5M6fouI_).
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    // Ambiguity is judged against the WHOLE capture — the same scope
    // `assignStableViewIds` assigns duplicate-group ordinals over (issue #6229,
    // review thread PRRT_kwDOP-GF5M6f1gS0). A content-identical peer OUTSIDE the
    // selected container still makes an ordinal id capture-local: once the
    // in-container original is removed, global re-ordinaling can reassign the
    // caller's `-<k>` string to a surviving peer, so a container-local count of
    // 1 would wrongly wave it through. Counting globally rejects it as ambiguous
    // instead — the same scope the ordinals were assigned in. The real-id
    // BYPASS inside that check stays scoped to the container's subtree (when
    // one is given), not the whole capture — a real resource-id match OUTSIDE
    // the container must not suppress an ambiguity that is genuine INSIDE it
    // (review thread PRRT_kwDOP-GF5M6f2X6J).
    const fullCaptureRoots = this.collectFullCaptureSearchRoots(viewHierarchy);
    this.assertStableViewIdSelectorNotAmbiguous(
      containerNode ? [containerNode] : fullCaptureRoots,
      fullCaptureRoots,
      resourceId,
    );

    if (containerNode) {
      // A real resource-id match anywhere in the container's subtree always
      // wins over a synthetic view-id match, never unioned with one (review
      // thread PRRT_kwDOP-GF5M6fo13g).
      const preferResourceIdOnly = this.hasExactResourceIdFieldMatch([containerNode], resourceId);
      return this.collectResourceIdMatchesInRoots(
        [containerNode],
        resourceId,
        partialMatch,
        !preserveTraversalOrder,
        preferResourceIdOnly,
      );
    }

    // Computed against the WHOLE capture (main + every window) so a real
    // resource-id match in one root is never shadowed by a stable-id match
    // encountered earlier in search order (review thread
    // PRRT_kwDOP-GF5M6fo2Iq).
    const preferResourceIdOnly = this.hasExactResourceIdFieldMatch(fullCaptureRoots, resourceId);

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectResourceIdMatchesInRoots(
      rootNodes,
      resourceId,
      partialMatch,
      !preserveTraversalOrder,
      preferResourceIdOnly,
    );
    if (mainMatches.length > 0) {
      return mainMatches;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatches = this.collectResourceIdMatchesInRoots(
        windowRoots,
        resourceId,
        partialMatch,
        !preserveTraversalOrder,
        preferResourceIdOnly,
      );
      if (windowMatches.length > 0) {
        return windowMatches;
      }
    }

    return [];
  }

  /**
   * Find element by resource ID
   * @param viewHierarchy - The view hierarchy to search
   * @param resourceId - Resource ID to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to allow partial ID matching
   * @returns The found element or null
   */
  findElementByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
  ): Element | null {
    const matches = this.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      container,
      partialMatch,
    );
    return matches[0] ?? null;
  }

  /**
   * Find elements by the top-level Android accessibility `test-tag` field.
   */
  findElementsByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    container: { elementId?: string; text?: string } | null = null,
    preserveTraversalOrder: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !testTag) {
      return [];
    }

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    if (containerNode) {
      return this.collectTestTagMatchesInRoots([containerNode], testTag, !preserveTraversalOrder);
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectTestTagMatchesInRoots(
      rootNodes,
      testTag,
      !preserveTraversalOrder,
    );
    if (mainMatches.length > 0) {
      return mainMatches;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatches = this.collectTestTagMatchesInRoots(
        windowRoots,
        testTag,
        !preserveTraversalOrder,
      );
      if (windowMatches.length > 0) {
        return windowMatches;
      }
    }

    return [];
  }

  /**
   * Find the container node in the view hierarchy.
   * @param viewHierarchy - The view hierarchy to search
   * @param container - Container element selector
   * @returns The matching container node or null if not found
   */
  findContainerNode(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null {
    return this.findContainerNodeInternal(viewHierarchy, container);
  }

  /**
   * Find an element by its index in the flattened view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @param index - The index of the element to find
   * @returns The element at the specified index or null if not found
   */
  findElementByIndex(
    viewHierarchy: ViewHierarchyResult,
    index: number,
  ): { element: Element; text?: string } | null {
    if (!viewHierarchy || index < 0) {
      return null;
    }

    const flattenedElements = this.parser.flattenViewHierarchy(viewHierarchy, {
      includeWindows: true,
      windowOrder: "topmost-first",
    });

    if (index >= flattenedElements.length) {
      return null;
    }

    const found = flattenedElements[index];
    return {
      element: found.element,
      text: found.text,
    };
  }

  /**
   * Find scrollable elements in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns Array of scrollable elements
   */
  findScrollableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const scrollables: Element[] = [];

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            scrollables.push(parsedNode);
          }
        }
      });
    }

    return scrollables;
  }

  /**
   * Find the first scrollable container element in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The first scrollable element found, or null
   */
  findScrollableContainer(viewHierarchy: ViewHierarchyResult): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainScrollable = this.findScrollableContainerInRoots(rootNodes);
    if (mainScrollable) {
      return mainScrollable;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowScrollable = this.findScrollableContainerInRoots(windowRoots);
      if (windowScrollable) {
        return windowScrollable;
      }
    }

    return null;
  }

  /**
   * Find clickable elements in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns Array of clickable elements
   */
  findClickableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const clickables: Element[] = [];

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (this.isClickableNode(nodeProperties)) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            clickables.push(parsedNode);
          }
        }
      });
    }

    return clickables;
  }

  /**
   * Find clickable elements, optionally restricted to a container.
   * @param viewHierarchy - The view hierarchy to search
   * @param container - Optional container to restrict search
   * @param scrollableContainer - If true, only search within scrollable elements
   * @returns Array of clickable elements
   */
  findClickableElementsInContainer(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string } | null = null,
    scrollableContainer: boolean = false,
  ): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    let searchRoots = containerNode
      ? [containerNode]
      : [
          ...this.parser.extractRootNodes(viewHierarchy),
          ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
        ];

    // If scrollableContainer is true, find all scrollable nodes first
    // and then search for clickables only within those
    if (scrollableContainer) {
      const scrollableNodes: any[] = [];
      for (const rootNode of searchRoots) {
        this.parser.traverseNode(rootNode, (node: any) => {
          const nodeProperties = this.parser.extractNodeProperties(node);
          if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
            scrollableNodes.push(node);
          }
        });
      }

      if (scrollableNodes.length > 0) {
        searchRoots = scrollableNodes;
      } else {
        // No scrollable containers found, return empty
        return [];
      }
    }

    const clickables: Element[] = [];

    for (const rootNode of searchRoots) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (this.isClickableNode(nodeProperties)) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            clickables.push(parsedNode);
          }
        }
      });
    }

    return clickables;
  }

  /**
   * Find child elements within a parent element's bounds
   * @param viewHierarchy - The view hierarchy to search
   * @param parentElement - The parent element
   * @returns Array of child elements
   */
  findChildElements(viewHierarchy: ViewHierarchyResult, parentElement: Element): Element[] {
    if (!viewHierarchy || !parentElement) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const childElements: Element[] = [];
    const parentBounds = parentElement.bounds;

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        const nodeBounds = this.parser.parseBounds(node.bounds ?? nodeProperties.bounds);

        if (!nodeBounds) {
          return;
        }

        // Check if the node is within the parent's bounds but not the parent itself
        const isWithin =
          nodeBounds.left >= parentBounds.left &&
          nodeBounds.top >= parentBounds.top &&
          nodeBounds.right <= parentBounds.right &&
          nodeBounds.bottom <= parentBounds.bottom;

        const isNotParent =
          nodeBounds.left !== parentBounds.left ||
          nodeBounds.top !== parentBounds.top ||
          nodeBounds.right !== parentBounds.right ||
          nodeBounds.bottom !== parentBounds.bottom;

        if (isWithin && isNotParent) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            childElements.push(parsedNode);
          }
        }
      });
    }

    // Sort elements by vertical position
    childElements.sort((a, b) => a.bounds.top - b.bounds.top);

    return childElements;
  }

  /**
   * Find elements that look like spannable text elements
   * @param element - The parent element to search within
   * @returns Array of spannable elements or null if none found
   */
  findSpannables(element: Element): Element[] | null {
    if (!element) {
      return null;
    }

    // Common classes for spannable text elements in Android
    const spannableClasses = [
      "android.widget.TextView",
      "android.widget.EditText",
      "android.widget.Button",
      "android.widget.CheckBox",
      "android.widget.RadioButton",
      "android.widget.Switch",
      "android.widget.Spinner",
    ];

    // Check if the element itself is a spannable
    if (
      element.class &&
      spannableClasses.some((cls) => element.class?.includes(cls)) &&
      element.text
    ) {
      return [element];
    }

    // Find all spannable children
    const spannables: Element[] = [];

    // Process each child if the node structure is available
    if (element.node) {
      const children = element.node;
      if (Array.isArray(children)) {
        for (const child of children) {
          const parsedNode = this.parser.parseNodeBounds(child);
          if (
            parsedNode &&
            parsedNode.class &&
            spannableClasses.some((cls) => parsedNode.class?.includes(cls)) &&
            parsedNode.text
          ) {
            spannables.push(parsedNode);
          }

          // Recursively search for spannables in this child
          if (parsedNode) {
            const childSpannables = this.findSpannables(parsedNode);
            if (childSpannables) {
              spannables.push(...childSpannables);
            }
          }
        }
      } else if (typeof children === "object") {
        const parsedNode = this.parser.parseNodeBounds(children);
        if (parsedNode) {
          const childSpannables = this.findSpannables(parsedNode);
          if (childSpannables) {
            spannables.push(...childSpannables);
          }
        }
      }
    }

    return spannables.length > 0 ? spannables : null;
  }

  /**
   * Find a focused text input in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The focused text input element or null if not found
   */
  findFocusedTextInput(viewHierarchy: any): any {
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatch = this.findFocusedTextInputInRoots(rootNodes, ANDROID_INPUT_CLASSES);
    if (mainMatch) {
      return mainMatch;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatch = this.findFocusedTextInputInRoots(windowRoots, ANDROID_INPUT_CLASSES);
      if (windowMatch) {
        return windowMatch;
      }
    }

    return null;
  }

  /**
   * Check if an element is currently focused based on view hierarchy attributes
   * @param element - The element to check
   * @returns True if the element appears to be focused
   */
  isElementFocused(element: any): boolean {
    // Check for focus-related attributes
    const focused = element.focused === "true" || element.focused === true;
    const selected = element.selected === "true" || element.selected === true;

    // Some UI frameworks use 'isFocused' instead of 'focused'
    const isFocused = element.isFocused === "true" || element.isFocused === true;

    // Check if element has keyboard focus (for text inputs)
    const hasKeyboardFocus =
      element["has-keyboard-focus"] === "true" || element["has-keyboard-focus"] === true;

    return focused || selected || isFocused || hasKeyboardFocus;
  }

  /**
   * Validate that an element with optional text matches expectations
   * @param foundElement - The element found by index
   * @param expectedText - Optional expected text for validation
   * @returns True if the element matches expectations
   */
  validateElementText(
    foundElement: { element: Element; text?: string },
    expectedText?: string,
  ): boolean {
    if (!expectedText) {
      return true; // No text validation required
    }

    if (!foundElement.text) {
      return false; // Expected text but element has no text
    }

    // Use partial matching for text validation
    return this.textMatcher.partialTextMatch(foundElement.text, expectedText, false);
  }

  /**
   * Find clickable parent elements that contain descendants matching the specified text.
   * This traverses the hierarchy looking for clickable elements that have a descendant
   * with matching text, returning the clickable parent (not the text element itself).
   *
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for in descendants
   * @param container - Container element selector to restrict the search
   * @param fuzzyMatch - Whether to use fuzzy matching
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of clickable parent elements containing the text
   */
  findClickableParentsContainingText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    fuzzyMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, fuzzyMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    const clickableParents = this.collectClickableParentsWithTextInRoots(searchRoots, matchesText);

    if (clickableParents.length > 0) {
      return clickableParents;
    }

    // Try window roots if no match in main hierarchy
    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableParentsWithTextInRoots(windowRoots, matchesText);
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  /**
   * Internal method to find clickable elements that have descendants with matching text.
   */
  private collectClickableParentsWithTextInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesText: (input?: string) => boolean,
  ): Element[] {
    const matches: Element[] = [];

    for (const rootNode of rootNodes) {
      this.findClickableParentsInNode(rootNode, matchesText, matches);
    }

    return matches;
  }

  /**
   * Find clickable elements that are siblings of elements containing the specified text.
   * This finds nodes that share the same parent as a text-matching node.
   *
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for in sibling elements
   * @param container - Container element selector to restrict the search
   * @param fuzzyMatch - Whether to use fuzzy matching
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of clickable sibling elements
   */
  findClickableSiblingsOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    fuzzyMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, fuzzyMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    const siblings = this.collectClickableSiblingsWithTextInRoots(searchRoots, matchesText);

    if (siblings.length > 0) {
      return siblings;
    }

    // Try window roots if no match in main hierarchy
    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableSiblingsWithTextInRoots(
          windowRoots,
          matchesText,
        );
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  findClickableSiblingsOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !resourceId) {
      return [];
    }

    // See collectResourceIdMatchesInRoots: Compose testTag nodes report a bare
    // viewIdResourceName with no package qualifier, so a fully-qualified query must also
    // match against the bare suffix - not just partialMatch/exact on the full string.
    const idSeparatorIndex = resourceId.lastIndexOf("/");
    const bareResourceId = idSeparatorIndex >= 0 ? resourceId.slice(idSeparatorIndex + 1) : null;

    // Resolve the container FIRST (same ordering fix as findElementsByResourceId)
    // so the ambiguity check can be scoped to just its subtree.
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    // Ambiguity is judged against the WHOLE capture — the same scope
    // `assignStableViewIds` assigns duplicate-group ordinals over (issue #6229,
    // review thread PRRT_kwDOP-GF5M6f1gS0): a content-identical peer outside a
    // selected container still makes an ordinal id capture-local, so a
    // container-local count would miss it and let a since-reassigned ordinal
    // resolve to the wrong peer. Resource-id PREFERENCE keeps its narrower
    // scope (container subtree when scoped, else whole capture) so a real
    // resource-id match is never unioned with, or shadowed in window-search
    // order by, a synthetic view-id match (review threads
    // PRRT_kwDOP-GF5M6fo13g, PRRT_kwDOP-GF5M6fo2Iq). The ambiguity check's
    // internal real-id BYPASS shares that same narrower scope, not the whole
    // capture — a real resource-id match outside the container must not
    // suppress an ambiguity that is genuine inside it (review thread
    // PRRT_kwDOP-GF5M6f2X6J).
    const fullCaptureRoots = this.collectFullCaptureSearchRoots(viewHierarchy);
    const preferResourceIdOnly = this.hasExactResourceIdFieldMatch(
      containerNode ? searchRoots : fullCaptureRoots,
      resourceId,
    );
    this.assertStableViewIdSelectorNotAmbiguous(
      containerNode ? searchRoots : fullCaptureRoots,
      fullCaptureRoots,
      resourceId,
    );

    const matchesId = (nodeProperties: Record<string, unknown>): boolean =>
      preferResourceIdOnly
        ? matchesResourceIdFieldOnly(nodeProperties, resourceId, bareResourceId, partialMatch)
        : matchesResourceIdOrStableViewId(nodeProperties, resourceId, bareResourceId, partialMatch);

    const siblings = this.collectClickableSiblingsWithResourceIdInRoots(searchRoots, matchesId);

    if (siblings.length > 0) {
      return siblings;
    }

    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableSiblingsWithResourceIdInRoots(
          windowRoots,
          matchesId,
        );
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  private collectClickableSiblingsWithResourceIdInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesId: (nodeProperties: Record<string, unknown>) => boolean,
  ): Element[] {
    const results: Element[] = [];
    for (const rootNode of rootNodes) {
      this.findClickableSiblingsOfResourceIdInNode(rootNode, matchesId, results);
    }
    return results;
  }

  private findClickableSiblingsOfResourceIdInNode(
    node: ViewHierarchyNode,
    matchesId: (nodeProperties: Record<string, unknown>) => boolean,
    results: Element[],
  ): void {
    const children = node.node;
    if (!children) {
      return;
    }

    const childArray: ViewHierarchyNode[] = Array.isArray(children) ? children : [children];

    const hasIdMatch = childArray.some((child) => {
      const props = this.parser.extractNodeProperties(child);
      return matchesId(props);
    });

    if (hasIdMatch) {
      for (const child of childArray) {
        const childProps = this.parser.extractNodeProperties(child);
        const isClickable = this.isClickableNode(childProps);
        const isIdMatch = matchesId(childProps);

        if (isClickable && !isIdMatch) {
          const parsedNode = this.parser.parseNodeBounds(child);
          if (parsedNode) {
            results.push(parsedNode);
          }
        }
      }
    }

    for (const child of childArray) {
      this.findClickableSiblingsOfResourceIdInNode(child, matchesId, results);
    }
  }

  /**
   * Internal method to find clickable siblings of text-matching elements.
   */
  private collectClickableSiblingsWithTextInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesText: (input?: string) => boolean,
  ): Element[] {
    const results: Element[] = [];

    for (const rootNode of rootNodes) {
      this.findClickableSiblingsInNode(rootNode, matchesText, results);
    }

    return results;
  }

  /**
   * Recursively find the clickable control that shares a ROW with a text-matching
   * element — the control a user taps "next to" that text (a remove button, a row
   * checkbox, etc.).
   *
   * The text is frequently NOT a direct sibling of the control. List rows commonly nest
   * the label under an intermediate container (e.g. a name/email pair inside an avatar
   * group) while the action sits as a sibling of that container. So we match on a child
   * whose SUBTREE contains the text (deep), and collect the clickable, non-text children
   * at the DEEPEST qualifying node — the row.
   *
   * Two rules keep the deep match precise, addressing the false-positive the previous
   * shallow (`nodeHasText`) version guarded against — i.e. stopping a list/recycler
   * ancestor from collecting every sibling row's control at once:
   *   - Recurse FIRST and bail if a descendant level already matched, so the nearest
   *     (deepest) row wins when the matching row yields a control.
   *   - Only collect at a node whose text-bearing child is NOT itself clickable. A
   *     clickable text-bearing child means that child is the row/list-item and THIS node
   *     is the list, so its other clickable children are sibling rows, not this row's
   *     control. This is essential when the matching row has NO control of its own:
   *     without it, recursion would unwind to the list and return a different row's
   *     control (a silent wrong tap); with it, the result is a clean "not found".
   * This keeps the old direct-sibling case working (the text's parent is the row) while
   * also reaching a nested label, which previously returned "no clickable sibling".
   */
  private findClickableSiblingsInNode(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
    results: Element[],
  ): void {
    const children = node.node;
    if (!children) {
      return;
    }

    const childArray: ViewHierarchyNode[] = Array.isArray(children) ? children : [children];

    // Recurse first so the DEEPEST (nearest-to-text) row wins. If a descendant level
    // already produced matches, don't also collect at this (ancestor) level — that is
    // what would pull sibling rows' controls in from a shared list container.
    const before = results.length;
    for (const child of childArray) {
      this.findClickableSiblingsInNode(child, matchesText, results);
    }
    if (results.length > before) {
      return;
    }

    // At this level, which child's SUBTREE contains the text (deep, so a label nested
    // under an avatar/content group still counts)?
    const textChild = childArray.find((child) => this.nodeOrDescendantHasText(child, matchesText));
    if (!textChild) {
      return;
    }

    // If that text-bearing child is ITSELF clickable under a collection node, it is a
    // row/list-item and THIS node is the list. Collecting here would grab a sibling
    // ROW's control. A non-collection parent can still be an actual row with a
    // clickable content group plus a trailing action, so let that case collect below.
    if (
      this.isClickableNode(this.parser.extractNodeProperties(textChild)) &&
      this.isCollectionNode(this.parser.extractNodeProperties(node))
    ) {
      return;
    }

    // THIS node is the row: its clickable, non-text children are the action control(s).
    for (const child of childArray) {
      const childProps = this.parser.extractNodeProperties(child);
      const isClickable = this.isClickableNode(childProps);

      if (isClickable && !this.nodeOrDescendantHasText(child, matchesText)) {
        const parsedNode = this.parser.parseNodeBounds(child);
        if (parsedNode) {
          results.push(parsedNode);
        }
      }
    }
  }

  /**
   * Recursively search for clickable elements that contain text-matching descendants.
   */
  private findClickableParentsInNode(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
    results: Element[],
  ): boolean {
    const nodeProperties = this.parser.extractNodeProperties(node);
    const isClickable = this.isClickableNode(nodeProperties);

    // Check if this node or any descendant has matching text
    const hasMatchingText = this.nodeOrDescendantHasText(node, matchesText);

    if (isClickable && hasMatchingText) {
      const parsedNode = this.parser.parseNodeBounds(node);
      if (parsedNode) {
        results.push(parsedNode);
      }
      // Don't recurse into children - we found a clickable parent
      return true;
    }

    // Recurse into children
    const children = node.node;
    if (children) {
      if (Array.isArray(children)) {
        for (const child of children) {
          this.findClickableParentsInNode(child, matchesText, results);
        }
      } else if (typeof children === "object") {
        this.findClickableParentsInNode(children as ViewHierarchyNode, matchesText, results);
      }
    }

    return false;
  }

  /**
   * Check if a node itself has text matching the predicate (shallow — no descendants).
   */
  private nodeHasText(node: ViewHierarchyNode, matchesText: (input?: string) => boolean): boolean {
    const props = this.parser.extractNodeProperties(node);
    const text = props.text;
    const contentDesc = props["content-desc"];
    const iosLabel = props["ios-accessibility-label"];

    return (
      (typeof text === "string" && matchesText(text)) ||
      (typeof contentDesc === "string" && matchesText(contentDesc)) ||
      (typeof iosLabel === "string" && matchesText(iosLabel))
    );
  }

  /**
   * Check if a node or any of its descendants has text matching the predicate.
   */
  private nodeOrDescendantHasText(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
  ): boolean {
    const nodeProperties = this.parser.extractNodeProperties(node);

    // Check this node's text properties
    const nodeText = nodeProperties.text;
    const nodeContentDesc = nodeProperties["content-desc"];
    const nodeIosLabel = nodeProperties["ios-accessibility-label"];

    if (
      (typeof nodeText === "string" && matchesText(nodeText)) ||
      (typeof nodeContentDesc === "string" && matchesText(nodeContentDesc)) ||
      (typeof nodeIosLabel === "string" && matchesText(nodeIosLabel))
    ) {
      return true;
    }

    // Recursively check children
    const children = node.node;
    if (children) {
      if (Array.isArray(children)) {
        for (const child of children) {
          if (this.nodeOrDescendantHasText(child, matchesText)) {
            return true;
          }
        }
      } else if (typeof children === "object") {
        if (this.nodeOrDescendantHasText(children as ViewHierarchyNode, matchesText)) {
          return true;
        }
      }
    }

    return false;
  }
}
