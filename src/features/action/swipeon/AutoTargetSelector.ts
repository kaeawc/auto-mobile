import { Element, ObserveResult, SwipeDirection, SwipeOnOptions } from "../../../models";
import { boundsArea, boundsEqual } from "../../../utils/bounds";
import { getScreenBounds as getScreenBoundsFromSize } from "../../../utils/screenBounds";
import { getHierarchySnapshot } from "../../observe/HierarchyCapture";
import { DefaultElementGeometry } from "../../utility/ElementGeometry";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { effectiveSwipeInsets, swipeScreenSize } from "./iosChromeInsets";
import { AutoTargetSelectorService } from "./types";

export class AutoTargetSelector implements AutoTargetSelectorService {
  constructor(
    private readonly geometry: Pick<
      ElementGeometry,
      "isPointInElement"
    > = new DefaultElementGeometry(),
  ) {}

  selectAutoTargetScrollable(
    scrollables: Element[],
    screenBounds: Element["bounds"] | null,
    direction: SwipeDirection,
  ): Element | null {
    const matching = scrollables.filter((element) => this.matchesDirection(element, direction));
    if (matching.length === 0) {
      return null;
    }

    const nonScreenScrollables = screenBounds
      ? matching.filter((scrollable) => !boundsEqual(scrollable.bounds, screenBounds))
      : matching;

    const candidates = nonScreenScrollables.length > 0 ? nonScreenScrollables : matching;
    if (screenBounds) {
      const centerX = (screenBounds.left + screenBounds.right) / 2;
      const centerY = (screenBounds.top + screenBounds.bottom) / 2;
      const centered = candidates.filter((element) =>
        this.geometry.isPointInElement(element, centerX, centerY),
      );
      if (centered.length > 0) {
        // For nested containers containing the centre, the smallest is innermost.
        return centered.reduce((inner, current) =>
          boundsArea(current.bounds) < boundsArea(inner.bounds) ? current : inner,
        );
      }
    }
    return this.pickLargestScrollable(candidates);
  }

  pickLargestScrollable(scrollables: Element[]): Element | null {
    if (scrollables.length === 0) {
      return null;
    }

    return scrollables.reduce((largest, current) => {
      const largestArea = boundsArea(largest.bounds);
      const currentArea = boundsArea(current.bounds);
      return currentArea > largestArea ? current : largest;
    });
  }

  matchesDirection(element: Element, direction: SwipeDirection): boolean {
    const vertical = direction === "up" || direction === "down";
    const orientation =
      typeof element.orientation === "string" ? element.orientation.toLowerCase() : undefined;
    if (orientation === "horizontal" || orientation === "vertical") {
      return vertical === (orientation === "vertical");
    }

    const className = element.class ?? element.className;
    const simpleClassName =
      typeof className === "string" ? (className.split(".").at(-1) ?? "") : "";
    if (["HorizontalScrollView", "ViewPager", "ViewPager2", "LazyRow"].includes(simpleClassName)) {
      return !vertical;
    }
    if (
      ["ScrollView", "NestedScrollView", "ListView", "ExpandableListView", "LazyColumn"].includes(
        simpleClassName,
      )
    ) {
      return vertical;
    }

    // RecyclerView and generic Compose nodes do not expose their axis in every
    // capture. scroll_forward/backward actions alone also do not identify it.
    const width = Math.abs(element.bounds.right - element.bounds.left);
    const height = Math.abs(element.bounds.bottom - element.bounds.top);

    if (vertical) {
      return height >= width;
    }

    return width >= height;
  }

  getScreenBounds(
    observeResult: ObserveResult,
    options: { platform?: "android" | "ios"; includeSystemInsets?: boolean } = {},
  ): Element["bounds"] | null {
    const platform =
      options.platform ?? getHierarchySnapshot(observeResult.viewHierarchy)?.platform;
    const insetOptions = {
      observation: observeResult,
      platform,
      // Android auto-target selection has always compared against inset screen
      // bounds, regardless of the eventual gesture's includeSystemInsets option.
      includeSystemInsets: platform === "ios" ? options.includeSystemInsets : undefined,
    };
    const screenSize = swipeScreenSize(insetOptions);
    if (!screenSize) {
      return null;
    }

    return getScreenBoundsFromSize(screenSize, effectiveSwipeInsets(insetOptions));
  }

  describeContainer(container: SwipeOnOptions["container"]): string {
    if (!container) {
      return "unknown";
    }
    if (container.elementId) {
      return `elementId="${container.elementId}"`;
    }
    if (container.text) {
      return `text="${container.text}"`;
    }
    return "unknown";
  }

  mergeWarnings(...warnings: Array<string | undefined>): string | undefined {
    const filtered = warnings.filter((warning): warning is string => Boolean(warning));
    if (filtered.length === 0) {
      return undefined;
    }
    return Array.from(new Set(filtered)).join(" ");
  }
}
