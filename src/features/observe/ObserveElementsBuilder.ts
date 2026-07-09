import { ObserveResult, ViewHierarchyResult } from "../../models";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../utility/ElementParser";
import { IdentifyMediaViews } from "./IdentifyMediaViews";
import { DefaultObserveElementCollector, ObserveElementCollector } from "./ObserveElementCollector";

export class ObserveElementsBuilder {
  private collector: ObserveElementCollector;

  constructor(
    _finder?: ElementFinder,
    parser: ElementParser = new DefaultElementParser(),
    mediaClassifier: IdentifyMediaViews = new IdentifyMediaViews(parser),
    collector: ObserveElementCollector = new DefaultObserveElementCollector(parser, mediaClassifier)
  ) {
    this.collector = collector;
  }

  build(viewHierarchy: ViewHierarchyResult, platform: "android" | "ios" = "android"): ObserveResult["elements"] {
    return this.collector.collect(viewHierarchy, platform);
  }
}
