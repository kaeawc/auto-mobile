import { describe, expect, test } from "bun:test";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { IdentifyMediaViews } from "../../../src/features/observe/IdentifyMediaViews";
import {
  DefaultObserveElementCollector,
  ObserveElementCollector,
} from "../../../src/features/observe/ObserveElementCollector";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../../fixtures/observe/observeFixture";

const createElement = (bounds: Element["bounds"]): Element => ({
  bounds,
});

class TraversalCountingParser extends DefaultElementParser {
  rootTraversalStarts = 0;

  override traverseNode(
    node: any,
    callback: (node: any, depth: number) => void,
    depth: number = 0,
  ): void {
    if (depth === 0) {
      this.rootTraversalStarts++;
    }
    super.traverseNode(node, callback, depth);
  }
}

class FakeObserveElementCollector implements ObserveElementCollector {
  nextElements: ReturnType<ObserveElementCollector["collect"]> = {
    clickable: [],
    scrollable: [],
    text: [],
    media: [],
  };
  lastViewHierarchy?: ViewHierarchyResult;
  lastPlatform?: "android" | "ios";

  collect(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
  ): ReturnType<ObserveElementCollector["collect"]> {
    this.lastViewHierarchy = viewHierarchy;
    this.lastPlatform = platform;
    return this.nextElements;
  }
}

const node = (
  attrs: Record<string, unknown>,
  children?: ViewHierarchyNode[],
): ViewHierarchyNode => ({
  $: attrs,
  bounds: attrs.bounds as Element["bounds"],
  ...(children ? { node: children } : {}),
});

const expectBuilderPreservesLegacyFixtureElements = (
  viewHierarchy: ViewHierarchyResult,
  platform: "android" | "ios",
): void => {
  const parser = new DefaultElementParser();
  const finder = new DefaultElementFinder(parser);
  const mediaClassifier = new IdentifyMediaViews(parser);
  const flattenedEntries = parser.flattenViewHierarchy(viewHierarchy, {
    includeWindows: true,
    windowOrder: "topmost-first",
  });
  const expected = {
    clickable: finder.findClickableElements(viewHierarchy),
    scrollable: finder.findScrollableElements(viewHierarchy),
    text: flattenedEntries
      .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
      .map((entry) => entry.element),
    media: mediaClassifier.classify(viewHierarchy, platform, flattenedEntries),
  };

  expect(new ObserveElementsBuilder().build(viewHierarchy, platform)).toEqual(expected);
};

describe("ObserveElementsBuilder", () => {
  test("returns the collector output for the requested platform", () => {
    const clickable = createElement({ left: 0, top: 0, right: 10, bottom: 10 });
    const scrollable = createElement({ left: 5, top: 5, right: 15, bottom: 15 });
    const textElement = createElement({ left: 10, top: 10, right: 20, bottom: 20 });
    const mediaElement = {
      className: "UIImageView",
      mediaType: "image" as const,
      bounds: { left: 20, top: 20, right: 30, bottom: 30 },
    };
    const viewHierarchy = { hierarchy: { node: {} } } as ViewHierarchyResult;
    const fakeCollector = new FakeObserveElementCollector();
    fakeCollector.nextElements = {
      clickable: [clickable],
      scrollable: [scrollable],
      text: [textElement],
      media: [mediaElement],
    };

    const builder = new ObserveElementsBuilder(fakeCollector);
    const elements = builder.build(viewHierarchy, "ios");

    expect(fakeCollector.lastViewHierarchy).toBe(viewHierarchy);
    expect(fakeCollector.lastPlatform).toBe("ios");
    expect(elements.clickable).toEqual([clickable]);
    expect(elements.scrollable).toEqual([scrollable]);
    expect(elements.text).toEqual([textElement]);
    expect(elements.media).toEqual([mediaElement]);
  });

  test("collects Android clickable, scrollable, text, and media elements from one traversal", () => {
    const clickableButton = node({
      bounds: { left: 0, top: 0, right: 40, bottom: 40 },
      class: "android.widget.Button",
      clickable: "true",
      text: "Tap me",
    });
    const scrollableList = node({
      bounds: { left: 0, top: 45, right: 120, bottom: 200 },
      class: "androidx.recyclerview.widget.RecyclerView",
      scrollable: true,
    });
    const blankText = node({
      bounds: { left: 0, top: 205, right: 120, bottom: 230 },
      class: "android.widget.TextView",
      text: "   ",
    });
    const mainImage = node({
      bounds: { left: 50, top: 0, right: 100, bottom: 50 },
      class: "android.widget.ImageView",
      "content-desc": "Hero image",
      "resource-id": "hero",
    });
    const topWindowText = node({
      bounds: { left: 0, top: 0, right: 80, bottom: 30 },
      class: "android.widget.TextView",
      text: "Overlay",
    });
    const bottomWindowVideo = node({
      bounds: { left: 0, top: 30, right: 80, bottom: 90 },
      class: "android.widget.VideoView",
    });
    const viewHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: node({ bounds: { left: 0, top: 0, right: 200, bottom: 300 }, class: "root" }, [
          clickableButton,
          scrollableList,
          blankText,
          mainImage,
        ]),
      },
      windows: [
        {
          windowLayer: 1,
          hierarchy: node(
            { bounds: { left: 0, top: 0, right: 100, bottom: 100 }, class: "bottomWindow" },
            [bottomWindowVideo],
          ),
        },
        {
          windowLayer: 2,
          hierarchy: node(
            { bounds: { left: 0, top: 0, right: 100, bottom: 100 }, class: "topWindow" },
            [topWindowText],
          ),
        },
      ],
    };

    const parser = new TraversalCountingParser();
    const builder = new ObserveElementsBuilder(
      new DefaultObserveElementCollector(parser, new IdentifyMediaViews(parser)),
    );

    const elements = builder.build(viewHierarchy, "android");

    expect(parser.rootTraversalStarts).toBe(3);
    expect(elements.clickable).toEqual([
      {
        ...clickableButton.$,
        bounds: clickableButton.bounds,
      },
    ]);
    expect(elements.scrollable).toEqual([
      {
        ...scrollableList.$,
        bounds: scrollableList.bounds,
      },
    ]);
    expect(elements.text).toEqual([
      { ...clickableButton.$, bounds: clickableButton.bounds },
      { ...mainImage.$, bounds: mainImage.bounds },
      { ...topWindowText.$, bounds: topWindowText.bounds },
    ]);
    expect(elements.media).toEqual([
      {
        className: "android.widget.ImageView",
        mediaType: "image",
        bounds: mainImage.bounds,
        contentDescription: "Hero image",
        resourceId: "hero",
      },
      {
        className: "android.widget.VideoView",
        mediaType: "video",
        bounds: bottomWindowVideo.bounds,
      },
    ]);
  });

  test("collects iOS text and media from the shared traversal without adding accessibility-label text", () => {
    const labelOnlyImage = node({
      bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      className: "CustomImageWidget",
      "ios-accessibility-label": "VoiceOver label",
      role: "image",
    });
    const explicitText = node({
      bounds: { left: 0, top: 60, right: 100, bottom: 90 },
      className: "UILabel",
      text: "Visible label",
    });
    const spinner = node({
      bounds: { left: 0, top: 100, right: 20, bottom: 120 },
      className: "UIActivityIndicatorView",
    });
    const viewHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: node({ bounds: { left: 0, top: 0, right: 200, bottom: 300 }, className: "root" }, [
          labelOnlyImage,
          explicitText,
          spinner,
        ]),
      },
    };

    const parser = new TraversalCountingParser();
    const builder = new ObserveElementsBuilder(
      new DefaultObserveElementCollector(parser, new IdentifyMediaViews(parser)),
    );

    const elements = builder.build(viewHierarchy, "ios");

    expect(parser.rootTraversalStarts).toBe(1);
    expect(elements.text).toEqual([{ ...explicitText.$, bounds: explicitText.bounds }]);
    expect(elements.media).toEqual([
      {
        className: "CustomImageWidget",
        mediaType: "image",
        bounds: labelOnlyImage.bounds,
      },
      {
        className: "UIActivityIndicatorView",
        mediaType: "loading",
        bounds: spinner.bounds,
        isLoading: true,
      },
    ]);
  });

  test("preserves Android observe fixture element output", () => {
    const { observe } = loadAndroidHomeObserve();
    expect(observe.viewHierarchy).toBeDefined();

    expectBuilderPreservesLegacyFixtureElements(observe.viewHierarchy!, "android");
  });

  test("preserves iOS observe fixture element output", () => {
    const observe = loadIosFractionalObserve();
    expect(observe.viewHierarchy).toBeDefined();

    expectBuilderPreservesLegacyFixtureElements(observe.viewHierarchy!, "ios");
  });
});
