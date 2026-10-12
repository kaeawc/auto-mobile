import { beforeAll, describe, expect, test } from "bun:test";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

type Paint = (x: number, y: number) => number | undefined;

/** A grey-scale canvas: each painter returns a level for the pixel or leaves it to the next. */
function canvas(width: number, height: number, background: number, painters: Paint[]): RawImage {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = painters.reduce<number | undefined>((v, paint) => v ?? paint(x, y), undefined);
      data.fill(value ?? background, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { width, height, data };
}

const rect =
  (left: number, top: number, right: number, bottom: number, value: number): Paint =>
  (x, y) =>
    x >= left && x < right && y >= top && y < bottom ? value : undefined;

const disc =
  (cx: number, cy: number, r: number, value: number): Paint =>
  (x, y) =>
    (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? value : undefined;

/** Glyph-like bars: `width`-px strokes every `pitch` px across [left,right) x [top,bottom). */
const glyphs =
  (
    left: number,
    top: number,
    right: number,
    bottom: number,
    value: number,
    width = 3,
    pitch = 10,
  ): Paint =>
  (x, y) =>
    x >= left && x < right && y >= top && y < bottom && (x - left) % pitch < width
      ? value
      : undefined;

/**
 * Rendering a canvas pixel by pixel is one-time work that does not belong in a timed test (CI's
 * per-test time includes the test body): each describe renders its fixtures in `beforeAll`, which
 * the budget excludes. The images are never mutated, so tests share them.
 */
function renderInBeforeAll(renderers: Record<string, () => RawImage>): Record<string, RawImage> {
  const images: Record<string, RawImage> = {};
  beforeAll(() => {
    for (const [key, render] of Object.entries(renderers)) {
      images[key] = render();
    }
  });
  return images;
}

function check(image: RawImage, bounds: Element["bounds"]) {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(image);
  const checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
  return checker.checkContrast("synthetic.png", { text: "label", bounds }, "AA", 420);
}

describe("solid-stroke sampling in a large box", () => {
  const images = renderInBeforeAll({
    large: () =>
      canvas(1008, 264, 255, [
        rect(24, 40, 104, 220, 0),
        rect(904, 40, 984, 220, 0),
        // Hairline stems on columns 379 and 441 (x = 375 and 437 inside the inset box) and
        // 3px stems between them: the 1000x256 inset box has area 256000, so 4096 evenly
        // spaced offsets visit only 16 columns, 62-63px apart.
        rect(379, 120, 380, 144, 200),
        rect(441, 120, 442, 144, 200),
        glyphs(386, 120, 436, 144, 200, 3, 7),
      ]),
  });
  test("a small low-contrast label between two high-contrast icons in a 1008x264 box fails", async () => {
    const result = await check(images.large!, { left: 0, top: 0, right: 1008, bottom: 264 });
    expect(result).not.toBeNull();
    expect(result!.textColor.r).toBe(200);
    expect(result!.meetsAA).toBe(false);
  });
});

/**
 * A 900x120 row: legible glyph bars and one inset tonal shape 20-40 from the background
 * (the faint-ink distance band). The shape is not text, so it must not set the ratio.
 */
describe("faint tonal shapes beside legible text are not text", () => {
  const bounds = { left: 0, top: 0, right: 900, bottom: 120 };
  const shapes: Record<string, (dark: boolean) => Paint> = {
    "solid chip": (dark) => rect(600, 30, 760, 90, dark ? 47 : 238),
    avatar: (dark) => disc(800, 60, 30, dark ? 47 : 238),
    divider: (dark) => rect(150, 100, 850, 103, dark ? 47 : 238),
    "progress track": (dark) => rect(560, 56, 860, 64, dark ? 47 : 238),
  };
  const renderers: Record<string, () => RawImage> = {};
  for (const dark of [false, true]) {
    for (const [name, shape] of Object.entries(shapes)) {
      renderers[`${dark}/${name}`] = () =>
        canvas(900, 120, dark ? 30 : 255, [glyphs(150, 40, 500, 80, dark ? 240 : 0), shape(dark)]);
    }
  }
  const images = renderInBeforeAll(renderers);
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const ink = dark ? 240 : 0;
    for (const name of Object.keys(shapes)) {
      test(`${theme}: an inset ${name} does not replace the text colour`, async () => {
        const result = await check(images[`${dark}/${name}`]!, bounds);
        expect(result).not.toBeNull();
        expect(result!.textColor.r).toBe(ink);
        expect(result!.meetsAA).toBe(true);
      });
    }
  }
});

describe("faint glyph-shaped strokes beside legible text are still text", () => {
  /** Faint "o" rings: each one fills well under half of its bounding box. */
  const rings =
    (value: number): Paint =>
    (x, y) => {
      if (x < 560 || x >= 860 || y < 45 || y >= 75) {
        return undefined;
      }
      const d = (((x - 560) % 30) - 15) ** 2 + (y - 60) ** 2;
      return d >= 64 && d <= 144 ? value : undefined;
    };
  const images = renderInBeforeAll({
    light: () => canvas(900, 120, 255, [glyphs(150, 40, 500, 80, 0), rings(238)]),
    dark: () => canvas(900, 120, 30, [glyphs(150, 40, 500, 80, 240), rings(47)]),
  });
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    test(`${theme}: faint ring glyphs keep the lower contrast`, async () => {
      const faint = dark ? 47 : 238;
      const result = await check(images[theme]!, { left: 0, top: 0, right: 900, bottom: 120 });
      expect(result).not.toBeNull();
      expect(result!.textColor.r).toBe(faint);
      expect(result!.meetsAA).toBe(false);
    });
  }
});
