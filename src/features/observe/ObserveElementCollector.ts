import { boundsArea, intersectBounds, parseBounds } from "../../utils/bounds";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ObserveResult, ViewHierarchyResult } from "../../models";
import type { Element } from "../../models/Element";
import {
  SearchableHierarchy,
  type SearchableEntry,
  type SearchableNode,
} from "../utility/SearchableNode";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { FlattenedElementEntry, IdentifyMediaViews } from "./IdentifyMediaViews";
import { IOS_KEYBOARD_CONTAINER_CLASSES, IOS_KEYBOARD_KEY_CLASS } from "./ios/IosScreenIdentity";
import {
  ElementProvenance,
  setElementProvenance,
  setCapturedKeyboard,
  setUncollectedWrappers,
  setHierarchyNodeSource,
} from "./output/elementProvenance";

export interface ObserveElementCollector {
  collect(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
  ): ObserveResult["elements"];
}

export class DefaultObserveElementCollector implements ObserveElementCollector {
  private readonly searchableHierarchy: SearchableHierarchy;
  constructor(
    private readonly parser: ElementParser = new DefaultElementParser(),
    private readonly mediaClassifier: IdentifyMediaViews = new IdentifyMediaViews(parser),
  ) {
    this.searchableHierarchy = new SearchableHierarchy(parser);
  }

  collect(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
  ): ObserveResult["elements"] {
    const clickable: Element[] = [];
    const scrollable: Element[] = [];
    const flattenedEntries: FlattenedElementEntry[] = [];
    const uncollectedWrappers: Element[] = [];
    let currentIndex = 0;
    let keyboardPackage: string | undefined;

    // Each root/window becomes its own ancestry group so downstream skeleton
    // hoisting/suppression can tell a genuine descendant from an unrelated node
    // in another window (issue #5881). `mainRootCount` keeps every main-hierarchy
    // root in a single group while each window root gets its own.
    const rootGroups = new Map<number, SearchableEntry[]>();
    const seen = new Set<SearchableEntry["source"]>();
    const projected = this.searchableHierarchy.project(viewHierarchy);
    const windowRanks = new Map<SearchableEntry["source"], number>();
    for (const entry of projected) {
      windowRanks.set(
        entry.source,
        Math.min(windowRanks.get(entry.source) ?? Infinity, entry.windowRank),
      );
    }
    const keyboardWindows =
      platform === "android"
        ? this.keyboardWindowBounds(
            resolveViewHierarchyForSearch(viewHierarchy) ?? viewHierarchy,
            windowRanks,
          )
        : new Map<number, ElementBounds>();
    // Keep the live selector's main-first order until action consumers migrate.
    for (const entry of projected) {
      if (seen.has(entry.source)) {
        continue;
      }
      seen.add(entry.source);
      const group = rootGroups.get(entry.rootGroup) ?? [];
      group.push({ ...entry, windowRank: windowRanks.get(entry.source)! });
      rootGroups.set(entry.rootGroup, group);
    }

    // Shared pre-order counter + parent records so ancestry intervals are
    // computed once after every root is walked.
    const provenanceState: ProvenanceState = { enter: 0, records: [] };

    for (const [group, entries] of rootGroups) {
      keyboardPackage =
        this.collectFromRoot(entries, group, platform, provenanceState, keyboardWindows, {
          clickable,
          scrollable,
          flattenedEntries,
          uncollectedWrappers,
          nextIndex: () => currentIndex++,
        }) ?? keyboardPackage;
    }

    finalizeProvenanceExits(provenanceState.records);

    const text = flattenedEntries
      .filter((entry) => hasCollectableText(entry.text))
      .map((entry) => entry.element);
    const media = this.mediaClassifier.classify(viewHierarchy, platform, flattenedEntries);

    const elements: NonNullable<ObserveResult["elements"]> = { clickable, scrollable, text, media };
    // Like element ancestry, this is output-projection metadata, not raw element content.
    if (keyboardPackage) {
      setCapturedKeyboard(elements, { visible: true, package: keyboardPackage });
    }
    if (uncollectedWrappers.length > 0) {
      setUncollectedWrappers(elements, uncollectedWrappers);
    }
    return elements;
  }

  private keyboardWindowBounds(
    hierarchy: ViewHierarchyResult,
    windowRanks: ReadonlyMap<SearchableEntry["source"], number>,
  ): Map<number, ElementBounds> {
    const frames = new Map<number, ElementBounds>();
    // AccessibilityWindowInfo.TYPE_INPUT_METHOD owns touches across its full frame.
    const inputMethodWindows =
      hierarchy.windows?.filter((window) => window.type === 2 && window.hierarchy) ?? [];
    for (const window of inputMethodWindows) {
      let bounds = parseBounds(window.bounds);
      if (!bounds || !Object.values(bounds).every(Number.isFinite)) {
        continue;
      }
      if (hierarchy.screenWidth && hierarchy.screenHeight) {
        bounds = intersectBounds(bounds, {
          left: 0,
          top: 0,
          right: hierarchy.screenWidth,
          bottom: hierarchy.screenHeight,
        });
      }
      if (!bounds || boundsArea(bounds) <= 0) {
        continue;
      }
      const roots =
        this.parser.extractWindowRootGroups({ hierarchy: {}, windows: [window] })[0] ?? [];
      const rank = roots.map((root) => windowRanks.get(root)).find((value) => value !== undefined);
      if (rank !== undefined) {
        frames.set(rank, bounds);
      }
    }
    return frames;
  }

  private collectFromRoot(
    entries: readonly SearchableEntry[],
    group: number,
    platform: "android" | "ios",
    provenanceState: ProvenanceState,
    keyboardWindows: ReadonlyMap<number, ElementBounds>,
    collections: {
      clickable: Element[];
      scrollable: Element[];
      flattenedEntries: FlattenedElementEntry[];
      uncollectedWrappers: Element[];
      nextIndex: () => number;
    },
  ): string | undefined {
    // Stack of enclosing parsed nodes (by tree depth) so each parsed node links
    // to its nearest parsed ancestor — bounds-less nodes are skipped in the
    // arrays but must not break ancestry between the nodes that survive.
    const ancestors: { depth: number; provenance: ElementProvenance }[] = [];
    let keyboardRoot: KeyboardRoot | undefined;
    let capturedKeyboardPackage: string | undefined;

    for (const searchable of entries) {
      const { properties: nodeProperties, depth } = searchable;
      // Public observe descriptors remain independently owned by each collection.
      const parsedNode = searchable.element ? structuredClone(searchable.element) : undefined;
      if (parsedNode) {
        setHierarchyNodeSource(parsedNode, searchable.source);
      }
      keyboardRoot = nextKeyboardRoot(
        keyboardRoot,
        nodeProperties.extras?.["automobile:imePackage"],
        nodeProperties,
        depth,
        platform,
      );
      capturedKeyboardPackage = keyboardRoot?.package ?? capturedKeyboardPackage;
      // Pop stale same-or-deeper entries for EVERY visited node, before the
      // bounds-less early return — otherwise a skipped wrapper never terminates a
      // preceding parsed sibling's ancestry, and the wrapper's parsed descendants
      // would inherit that sibling as their parent, mislabelling it with disjoint
      // text (issue #5881).
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= depth) {
        ancestors.pop();
      }

      if (!parsedNode) {
        continue;
      }

      const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1].provenance : undefined;
      const enter = provenanceState.enter++;
      const provenance: ElementProvenance = {
        windowRank: searchable.windowRank,
        group,
        enter,
        exit: enter,
        keyboardPackage: keyboardPackageForNode(keyboardRoot, nodeProperties),
        keyboardWindowBounds: keyboardWindows.get(searchable.windowRank),
      };
      setElementProvenance(parsedNode, provenance);
      provenanceState.records.push({ provenance, parent });
      ancestors.push({ depth, provenance });

      const actionable = collectActionableNode(parsedNode, searchable, collections);

      const accessibilityText = searchable.categoryText;
      collections.flattenedEntries.push({
        element: parsedNode,
        index: collections.nextIndex(),
        depth,
        text: accessibilityText,
      });
      if (isUncollectedWrapper(parsedNode, actionable, accessibilityText)) {
        collections.uncollectedWrappers.push(parsedNode);
      }
    }
    return capturedKeyboardPackage;
  }
}

/**
 * Categorize actions independently of traversal and IME ownership. Returns
 * whether the node landed in any actionable category.
 */
function collectActionableNode(
  element: Element,
  searchable: SearchableNode,
  collections: { clickable: Element[]; scrollable: Element[] },
): boolean {
  let collected = false;
  // A non-clickable switch still needs its toggle affordance (issue #6257).
  if (searchable.categories.clickable) {
    collections.clickable.push(element);
    collected = true;
  }
  if (searchable.categories.scrollable) {
    collections.scrollable.push(element);
    collected = true;
  }
  return collected;
}

/** The one test that admits a flattened entry into the `text` category. */
function hasCollectableText(text: unknown): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * A bounded node that no `elements` category will carry, yet bears a
 * `resource-id` — the only way a wrapper can be attributed to a package, and
 * the only thing that can place a legacy IME's own wrapper (issue #6908).
 */
function isUncollectedWrapper(element: Element, actionable: boolean, text: unknown): boolean {
  return (
    !actionable &&
    !hasCollectableText(text) &&
    typeof element["resource-id"] === "string" &&
    element["resource-id"].length > 0
  );
}

/** Track IME ownership even through bounds-less wrappers, ending it at the next sibling. */
function nextKeyboardRoot(
  current: KeyboardRoot | undefined,
  imePackage: unknown,
  nodeProperties: Element,
  depth: number,
  platform: "android" | "ios",
): KeyboardRoot | undefined {
  if (platform === "android" && typeof imePackage === "string" && imePackage.length > 0) {
    return { depth, package: imePackage };
  }
  if (platform === "ios") {
    return nextIosKeyboardRoot(current, nodeProperties, depth);
  }
  return current && depth > current.depth ? current : undefined;
}

interface KeyboardRoot {
  depth: number;
  package: string;
  memberClass?: string;
}

function getIosClassName(nodeProperties: Element): string | undefined {
  const classValue =
    typeof nodeProperties.class === "string" ? nodeProperties.class.trim() : undefined;
  const classNameValue =
    typeof nodeProperties.className === "string" ? nodeProperties.className.trim() : undefined;
  return classValue || classNameValue;
}

function nextIosKeyboardRoot(
  current: KeyboardRoot | undefined,
  nodeProperties: Element,
  depth: number,
): KeyboardRoot | undefined {
  // Mirror IosScreenIdentity.className: prefer a non-empty class, then className.
  const className = getIosClassName(nodeProperties);
  if (IOS_KEYBOARD_CONTAINER_CLASSES.has(className || "")) {
    return { depth, package: "com.apple.keyboard" };
  }
  const persistentRoot = current && depth > current.depth ? current : undefined;
  if (persistentRoot) {
    return persistentRoot;
  }
  return className === IOS_KEYBOARD_KEY_CLASS
    ? { depth: depth - 1, package: "com.apple.keyboard", memberClass: className }
    : undefined;
}

function keyboardPackageForNode(
  keyboardRoot: KeyboardRoot | undefined,
  nodeProperties: Element,
): string | undefined {
  if (!keyboardRoot || keyboardRoot.memberClass === undefined) {
    return keyboardRoot?.package;
  }
  return getIosClassName(nodeProperties) === keyboardRoot.memberClass
    ? keyboardRoot.package
    : undefined;
}

/** Shared pre-order counter and parent records accumulated across all roots. */
interface ProvenanceState {
  enter: number;
  records: { provenance: ElementProvenance; parent?: ElementProvenance }[];
}

/**
 * Compute each node's `exit` (the maximum `enter` in its parsed subtree) by
 * propagating child intervals up to parents. Processing in descending `enter`
 * order guarantees every descendant is folded into a node before that node
 * propagates to its own parent, since a parent always has a smaller `enter`.
 */
function finalizeProvenanceExits(
  records: { provenance: ElementProvenance; parent?: ElementProvenance }[],
): void {
  const ordered = [...records].sort((a, b) => b.provenance.enter - a.provenance.enter);
  for (const { provenance, parent } of ordered) {
    if (parent && provenance.exit > parent.exit) {
      parent.exit = provenance.exit;
    }
  }
}
