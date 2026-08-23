import { describe, test, expect } from "bun:test";
import { IdentifyMediaViews } from "../../../src/features/observe/IdentifyMediaViews";
import { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { ElementBounds } from "../../../src/models/ElementBounds";
import type { Element } from "../../../src/models/Element";
import { FakeElementParser } from "../../fakes/FakeElementParser";

function buildHierarchy(
  elements: Array<{
    className?: string;
    bounds?: ElementBounds;
    role?: string;
    extras?: Record<string, string>;
    resourceId?: string;
    viewId?: string;
    contentDesc?: string;
  }>,
): ViewHierarchyResult {
  const children = elements.map((el) => {
    const attrs: Record<string, any> = {};
    if (el.className) {
      attrs["class"] = el.className;
    }
    if (el.resourceId) {
      attrs["resource-id"] = el.resourceId;
    }
    if (el.viewId) {
      attrs["view-id"] = el.viewId;
    }
    if (el.contentDesc) {
      attrs["content-desc"] = el.contentDesc;
    }
    if (el.role) {
      attrs["role"] = el.role;
    }
    if (el.extras) {
      attrs["extras"] = el.extras;
    }
    if (el.bounds) {
      attrs["bounds"] = el.bounds;
    }
    return { $: attrs, bounds: el.bounds };
  });

  return {
    hierarchy: {
      node: {
        $: { class: "root", bounds: { left: 0, top: 0, right: 1080, bottom: 1920 } },
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        node: children,
      } as any,
    },
  };
}

const defaultBounds: ElementBounds = { left: 0, top: 0, right: 100, bottom: 100 };

describe("IdentifyMediaViews", () => {
  const classifier = new IdentifyMediaViews();

  test("Android ImageView classified as image", () => {
    const h = buildHierarchy([{ className: "android.widget.ImageView", bounds: defaultBounds }]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
    expect(result[0].className).toBe("android.widget.ImageView");
  });

  test("Android AppCompatImageView classified as image", () => {
    const h = buildHierarchy([
      { className: "androidx.appcompat.widget.AppCompatImageView", bounds: defaultBounds },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
  });

  test("Android VideoView classified as video", () => {
    const h = buildHierarchy([{ className: "android.widget.VideoView", bounds: defaultBounds }]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("video");
  });

  test("Android ProgressBar classified as loading with isLoading true", () => {
    const h = buildHierarchy([{ className: "android.widget.ProgressBar", bounds: defaultBounds }]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("loading");
    expect(result[0].isLoading).toBe(true);
  });

  test("Android ShimmerFrameLayout classified as loading", () => {
    const h = buildHierarchy([
      { className: "com.facebook.shimmer.ShimmerFrameLayout", bounds: defaultBounds },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("loading");
  });

  test("iOS UIImageView classified as image", () => {
    const h = buildHierarchy([{ className: "UIImageView", bounds: defaultBounds }]);
    const result = classifier.classify(h, "ios");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
  });

  test("iOS UIActivityIndicatorView classified as loading", () => {
    const h = buildHierarchy([{ className: "UIActivityIndicatorView", bounds: defaultBounds }]);
    const result = classifier.classify(h, "ios");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("loading");
    expect(result[0].isLoading).toBe(true);
  });

  test("iOS WKWebView classified as mixed", () => {
    const h = buildHierarchy([{ className: "WKWebView", bounds: defaultBounds }]);
    const result = classifier.classify(h, "ios");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("mixed");
  });

  test("Glide GlideImageView classified as image", () => {
    const h = buildHierarchy([
      { className: "com.bumptech.glide.request.target.GlideImageView", bounds: defaultBounds },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
  });

  test("Fresco SimpleDraweeView classified as image via DraweeView pattern", () => {
    const h = buildHierarchy([
      { className: "com.facebook.drawee.view.SimpleDraweeView", bounds: defaultBounds },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
  });

  test("ExoPlayer PlayerView classified as video", () => {
    const h = buildHierarchy([
      { className: "com.google.android.exoplayer2.ui.PlayerView", bounds: defaultBounds },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("video");
  });

  test("elements without bounds are skipped", () => {
    const h = buildHierarchy([{ className: "android.widget.ImageView" }]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(0);
  });

  test("generic android.view.View is not matched", () => {
    const h = buildHierarchy([{ className: "android.view.View", bounds: defaultBounds }]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(0);
  });

  test("viewId propagated from element view-id field", () => {
    const h = buildHierarchy([
      { className: "android.widget.ImageView", bounds: defaultBounds, viewId: "hero_image" },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].viewId).toBe("hero_image");
  });

  test("sourceUrl extracted from extras with URL value", () => {
    const h = buildHierarchy([
      {
        className: "android.widget.ImageView",
        bounds: defaultBounds,
        extras: { src: "https://example.com/image.png", other: "not-a-url" },
      },
    ]);
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(1);
    expect(result[0].sourceUrl).toBe("https://example.com/image.png");
  });

  test("iOS role-based detection for non-standard className", () => {
    const h = buildHierarchy([
      { className: "CustomImageWidget", bounds: defaultBounds, role: "image" },
    ]);
    const result = classifier.classify(h, "ios");
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image");
    expect(result[0].className).toBe("CustomImageWidget");
  });

  test("iOS className key (camelCase) used for media classification", () => {
    // iOS hierarchy nodes use "className" not "class" — build attrs directly
    const h: ViewHierarchyResult = {
      hierarchy: {
        node: {
          $: { class: "root", bounds: { left: 0, top: 0, right: 1080, bottom: 1920 } },
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            { $: { className: "UIImageView", bounds: defaultBounds }, bounds: defaultBounds },
            {
              $: {
                className: "AVPlayerView",
                bounds: { left: 0, top: 100, right: 100, bottom: 200 },
              },
              bounds: { left: 0, top: 100, right: 100, bottom: 200 },
            },
          ],
        } as any,
      },
    };
    const result = classifier.classify(h, "ios");
    expect(result).toHaveLength(2);
    expect(result[0].mediaType).toBe("image");
    expect(result[0].className).toBe("UIImageView");
    expect(result[1].mediaType).toBe("video");
    expect(result[1].className).toBe("AVPlayerView");
  });

  test("empty hierarchy returns empty array", () => {
    const h: ViewHierarchyResult = { hierarchy: {} };
    const result = classifier.classify(h, "android");
    expect(result).toHaveLength(0);
  });

  describe("platform isolation", () => {
    // Pins which class names cross the platform boundary. Android-only patterns
    // (android.widget.*, ShimmerFrameLayout) do NOT match on iOS, and most
    // iOS-only patterns do NOT match on Android. The one deliberate exception is
    // "UIImageView": it is matched on Android too (the audit's proposed
    // `android + UIImageView -> null` row was refuted -- it resolves to "image").
    const cases: Array<{
      className: string;
      platform: "android" | "ios";
      expected: string | null;
    }> = [
      { className: "UIImageView", platform: "android", expected: "image" },
      { className: "UIActivityIndicatorView", platform: "android", expected: null },
      { className: "WKWebView", platform: "android", expected: null },
      { className: "android.widget.ImageView", platform: "ios", expected: null },
      { className: "android.widget.VideoView", platform: "ios", expected: null },
      { className: "com.facebook.shimmer.ShimmerFrameLayout", platform: "ios", expected: null },
    ];

    cases.forEach(({ className, platform, expected }) => {
      test(`${className} on ${platform} -> ${expected ?? "not matched"}`, () => {
        const result = classifier.classify(
          buildHierarchy([{ className, bounds: defaultBounds }]),
          platform,
        );
        if (expected === null) {
          expect(result).toHaveLength(0);
        } else {
          expect(result).toHaveLength(1);
          expect(result[0].mediaType).toBe(expected);
        }
      });
    });
  });

  test("classifies media from pre-flattened entries without flattening hierarchy", () => {
    class NoFlattenParser extends FakeElementParser {
      override flattenViewHierarchy(): Array<{
        element: Element;
        index: number;
        depth: number;
        text?: string;
      }> {
        throw new Error("flattenViewHierarchy should not be called");
      }
    }

    const imageElement: Element = {
      bounds: defaultBounds,
      class: "android.widget.ImageView",
    };
    const result = new IdentifyMediaViews(new NoFlattenParser()).classify(
      { hierarchy: {} },
      "android",
      [{ element: imageElement, index: 0, depth: 0 }],
    );

    expect(result).toEqual([
      {
        className: "android.widget.ImageView",
        mediaType: "image",
        bounds: defaultBounds,
      },
    ]);
  });
});
