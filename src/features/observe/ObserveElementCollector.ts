import type { ObserveResult, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { Element } from "../../models/Element";
import { isClickableElementProperties } from "../../utils/elementProperties";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { FlattenedElementEntry, IdentifyMediaViews } from "./IdentifyMediaViews";

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

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];

    for (const rootNode of rootNodes) {
      this.collectFromRoot(rootNode, {
        clickable,
        scrollable,
        flattenedEntries,
        nextIndex: () => currentIndex++,
      });
    }

    const text = flattenedEntries
      .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
      .map((entry) => entry.element);
    const media = this.mediaClassifier.classify(viewHierarchy, platform, flattenedEntries);

    return { clickable, scrollable, text, media };
  }

  private collectFromRoot(
    rootNode: ViewHierarchyNode,
    collections: {
      clickable: Element[];
      scrollable: Element[];
      flattenedEntries: FlattenedElementEntry[];
      nextIndex: () => number;
    },
  ): void {
    this.parser.traverseNode(rootNode, (node: ViewHierarchyNode, depth: number) => {
      const parsedNode = this.parser.parseNodeBounds(node);
      if (!parsedNode) {
        return;
      }

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
