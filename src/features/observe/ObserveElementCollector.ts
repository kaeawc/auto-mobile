import type { ObserveResult, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { Element } from "../../models/Element";
import { isClickableElementProperties } from "../../utils/elementProperties";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { FlattenedElementEntry, IdentifyMediaViews } from "./IdentifyMediaViews";
import { ElementProvenance, setElementProvenance } from "./output/elementProvenance";

export interface ObserveElementCollector {
  collect(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
  ): ObserveResult["elements"];
}

export class DefaultObserveElementCollector implements ObserveElementCollector {
  constructor(
    private readonly parser: ElementParser = new DefaultElementParser(),
    private readonly mediaClassifier: IdentifyMediaViews = new IdentifyMediaViews(parser),
  ) {}

  collect(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
  ): ObserveResult["elements"] {
    const clickable: Element[] = [];
    const scrollable: Element[] = [];
    const flattenedEntries: FlattenedElementEntry[] = [];
    let currentIndex = 0;

    // Each root/window becomes its own ancestry group so downstream skeleton
    // hoisting/suppression can tell a genuine descendant from an unrelated node
    // in another window (issue #5881). `mainRootCount` keeps every main-hierarchy
    // root in a single group while each window root gets its own.
    const mainRoots = this.parser.extractRootNodes(viewHierarchy);
    const windowRoots = this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first");
    const rootGroups: { root: ViewHierarchyNode; group: number }[] = [
      ...mainRoots.map((root) => ({ root, group: 0 })),
      ...windowRoots.map((root, index) => ({ root, group: index + 1 })),
    ];

    // Shared pre-order counter + parent records so ancestry intervals are
    // computed once after every root is walked.
    const provenanceState: ProvenanceState = { enter: 0, records: [] };

    for (const { root, group } of rootGroups) {
      this.collectFromRoot(root, group, provenanceState, {
        clickable,
        scrollable,
        flattenedEntries,
        nextIndex: () => currentIndex++,
      });
    }

    finalizeProvenanceExits(provenanceState.records);

    const text = flattenedEntries
      .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
      .map((entry) => entry.element);
    const media = this.mediaClassifier.classify(viewHierarchy, platform, flattenedEntries);

    return { clickable, scrollable, text, media };
  }

  private collectFromRoot(
    rootNode: ViewHierarchyNode,
    group: number,
    provenanceState: ProvenanceState,
    collections: {
      clickable: Element[];
      scrollable: Element[];
      flattenedEntries: FlattenedElementEntry[];
      nextIndex: () => number;
    },
  ): void {
    // Stack of enclosing parsed nodes (by tree depth) so each parsed node links
    // to its nearest parsed ancestor — bounds-less nodes are skipped in the
    // arrays but must not break ancestry between the nodes that survive.
    const ancestors: { depth: number; provenance: ElementProvenance }[] = [];

    this.parser.traverseNode(rootNode, (node: ViewHierarchyNode, depth: number) => {
      const parsedNode = this.parser.parseNodeBounds(node);
      if (!parsedNode) {
        return;
      }

      while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= depth) {
        ancestors.pop();
      }
      const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1].provenance : undefined;
      const enter = provenanceState.enter++;
      const provenance: ElementProvenance = { group, enter, exit: enter };
      setElementProvenance(parsedNode, provenance);
      provenanceState.records.push({ provenance, parent });
      ancestors.push({ depth, provenance });

      const nodeProperties = this.parser.extractNodeProperties(node);
      if (isClickableElementProperties(nodeProperties)) {
        collections.clickable.push(parsedNode);
      }
      if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
        collections.scrollable.push(parsedNode);
      }

      const accessibilityText = nodeProperties.text || nodeProperties["content-desc"] || undefined;
      collections.flattenedEntries.push({
        element: parsedNode,
        index: collections.nextIndex(),
        depth,
        text: accessibilityText,
      });
    });
  }
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
