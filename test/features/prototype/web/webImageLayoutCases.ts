/**
 * Un-padded inlined image fixtures for the browser layout check (#17716). #17679 wrapped every
 * inlined image's layers in an in-flow content box and moved the image's ratio onto it; an image
 * with no padding must still lay out exactly as before. Each image carries a `testTag`, so the
 * check reads its box, its parent's and its drawn layer's by `data-testid`.
 *
 * Pure data: no source import, so the golden can be captured from any commit's renderer.
 */

/** The two assets the fixtures draw, with the size their encode reports (their intrinsic ratio). */
export const WEB_IMAGE_LAYOUT_ASSETS = [
  { id: "landscape", width: 240, height: 160 },
  { id: "portrait", width: 90, height: 160 },
] as const;

const SCALES = ["crop", "fit", "fill"] as const;

function image(tag: string, asset: string, style: Record<string, unknown>, scale?: string) {
  return {
    type: "image",
    testTag: tag,
    asset,
    ...(scale === undefined ? {} : { contentScale: scale }),
    style,
  };
}

const perScale = (
  name: string,
  asset: string,
  style: Record<string, unknown>,
): Record<string, unknown>[] =>
  SCALES.map((scale) => image(`${name}-${scale}`, asset, style, scale));

/** One screen of un-padded images in a column, in rows, and weighted. */
export const WEB_IMAGE_LAYOUT_SPEC = {
  id: "image-layout",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "scroll",
    style: { width: "fill", height: "fill" },
    child: {
      type: "column",
      testTag: "column",
      style: { width: "fill" },
      children: [
        ...perScale("fill-width", "landscape", { width: "fill" }),
        ...perScale("fill-width-portrait", "portrait", { width: "fill" }),
        ...perScale("fixed", "landscape", { width: { dp: 120 }, height: { dp: 80 } }),
        ...perScale("fixed-width", "landscape", { width: { dp: 100 } }),
        ...perScale("fixed-height", "portrait", { height: { dp: 60 } }),
        image("wrapped", "landscape", {}),
        image("fill-both", "landscape", { width: "fill", height: { dp: 50 } }, "crop"),
        image("authored-ratio", "landscape", { width: "fill", aspectRatio: 2 }, "crop"),
        image("bounded", "landscape", { width: "fill", maxHeight: 90, minHeight: 70 }, "fit"),
        {
          type: "row",
          testTag: "row-fixed",
          style: { width: "fill" },
          children: [
            ...perScale("row-fixed", "landscape", { width: { dp: 64 }, height: { dp: 64 } }),
            image("row-wrapped-width", "portrait", { height: { dp: 48 } }, "fit"),
          ],
        },
        {
          type: "row",
          testTag: "row-weighted",
          style: { width: "fill", height: { dp: 72 } },
          children: [
            image("row-weight-1", "landscape", { weight: 1, height: "fill" }, "crop"),
            image("row-weight-2", "portrait", { weight: 2 }, "fit"),
            image("row-weight-fixed", "landscape", { weight: 1, width: { dp: 40 } }, "fill"),
          ],
        },
        {
          type: "row",
          testTag: "row-wrapped",
          children: [
            image("row-wrapped", "landscape", {}, "crop"),
            image("row-fill-height", "portrait", { height: "fill" }, "fit"),
          ],
        },
        {
          type: "column",
          testTag: "column-weighted",
          style: { width: { dp: 200 }, height: { dp: 200 } },
          children: [
            image("column-weight-1", "landscape", { weight: 1, width: "fill" }, "crop"),
            image("column-weight-1-wrapped", "portrait", { weight: 1 }, "fit"),
          ],
        },
      ],
    },
  },
};

/** The `testTag` of every image fixture, in document order. */
export function webImageLayoutTags(): string[] {
  const tags: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    const raw = node as Record<string, unknown>;
    if (raw.type === "image" && typeof raw.testTag === "string") {
      tags.push(raw.testTag);
    }
    for (const child of [raw.child, ...(Array.isArray(raw.children) ? raw.children : [])]) {
      visit(child);
    }
  };
  visit(WEB_IMAGE_LAYOUT_SPEC.root);
  return tags;
}

/** One fixture's boxes, in CSS px rounded to 1/1000 px: the image, its parent and its drawn layer. */
export interface WebImageLayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WebImageLayoutBoxes {
  readonly image: WebImageLayoutRect;
  readonly parent: WebImageLayoutRect;
  readonly layer: WebImageLayoutRect;
}

/** A tag whose boxes differ between two measures, with both sides. */
export interface WebImageLayoutDifference {
  readonly tag: string;
  readonly expected: WebImageLayoutBoxes | undefined;
  readonly actual: WebImageLayoutBoxes | undefined;
}

/** The fixtures whose boxes differ by more than `tolerance` px on any edge. */
export function webImageLayoutDifferences(
  expected: Readonly<Record<string, WebImageLayoutBoxes>>,
  actual: Readonly<Record<string, WebImageLayoutBoxes>>,
  tolerance = 0.01,
): WebImageLayoutDifference[] {
  const tags = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const close = (a: WebImageLayoutRect, b: WebImageLayoutRect) =>
    (["x", "y", "width", "height"] as const).every((key) => Math.abs(a[key] - b[key]) <= tolerance);
  const same = (a: WebImageLayoutBoxes | undefined, b: WebImageLayoutBoxes | undefined) =>
    a !== undefined &&
    b !== undefined &&
    close(a.image, b.image) &&
    close(a.parent, b.parent) &&
    close(a.layer, b.layer);
  return tags
    .filter((tag) => !same(expected[tag], actual[tag]))
    .map((tag) => ({ tag, expected: expected[tag], actual: actual[tag] }));
}

/** The viewport the golden was measured in; the page scales its frame to it. */
export const WEB_IMAGE_LAYOUT_VIEWPORT = { width: 1280, height: 900 } as const;

/**
 * Runs in the page (self-contained for `page.evaluate`): each tag's image, parent and first drawn
 * layer box, by `getBoundingClientRect`, rounded to 1/1000 px. A tag with no image is left out.
 */
export function measureWebImageLayout(
  tags: readonly string[],
): Record<string, WebImageLayoutBoxes> {
  const rect = (element: Element): WebImageLayoutRect => {
    const box = element.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
  };
  const boxes: Record<string, WebImageLayoutBoxes> = {};
  for (const tag of tags) {
    const image = document.querySelector(`[data-testid="${tag}"]`);
    const layer = image?.querySelector("[data-image]");
    if (image?.parentElement && layer) {
      boxes[tag] = { image: rect(image), parent: rect(image.parentElement), layer: rect(layer) };
    }
  }
  return boxes;
}
