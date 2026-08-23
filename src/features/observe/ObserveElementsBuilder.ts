import { ObserveResult, ViewHierarchyResult } from "../../models";
import { DefaultObserveElementCollector, ObserveElementCollector } from "./ObserveElementCollector";

export class ObserveElementsBuilder {
  private collector: ObserveElementCollector;

  constructor(collector: ObserveElementCollector = new DefaultObserveElementCollector()) {
    this.collector = collector;
  }

  build(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios" = "android",
  ): ObserveResult["elements"] {
    return this.collector.collect(viewHierarchy, platform);
  }
}
