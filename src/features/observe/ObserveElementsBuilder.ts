import { ObserveResult, ViewHierarchyResult } from "../../models";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementFinder } from "../utility/ElementFinder";
import { DefaultElementParser } from "../utility/ElementParser";
import { IdentifyMediaViews } from "./IdentifyMediaViews";

export class ObserveElementsBuilder {
  private finder: ElementFinder;
  private parser: ElementParser;
  private mediaClassifier: IdentifyMediaViews;

  constructor(
    finder: ElementFinder = new DefaultElementFinder(),
    parser: ElementParser = new DefaultElementParser(),
    mediaClassifier: IdentifyMediaViews = new IdentifyMediaViews()
  ) {
    this.finder = finder;
    this.parser = parser;
    this.mediaClassifier = mediaClassifier;
  }

  build(viewHierarchy: ViewHierarchyResult, platform: "android" | "ios" = "android"): ObserveResult["elements"] {
    const clickable = this.finder.findClickableElements(viewHierarchy);
    const scrollable = this.finder.findScrollableElements(viewHierarchy);
    const flattenedEntries = this.parser.flattenViewHierarchy(viewHierarchy, {
      includeWindows: true,
      windowOrder: "topmost-first"
    });
    const text = flattenedEntries
      .filter(entry => typeof entry.text === "string" && entry.text.trim().length > 0)
      .map(entry => entry.element);
    const media = this.mediaClassifier.classify(viewHierarchy, platform, flattenedEntries);

    return { clickable, scrollable, text, media };
  }
}
