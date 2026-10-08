import { describe, expect, test } from "bun:test";
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

function check(image: RawImage, bounds: Element["bounds"]) {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(image);
  const checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
  return checker.checkContrast("synthetic.png", { text: "label", bounds }, "AA", 420);
}

describe("solid-stroke sampling in a large box", () => {
  test("a small low-contrast label between two high-contrast icons in a 1008x264 box fails", async () => {
    const image = canvas(1008, 264, 255, [
      rect(24, 40, 104, 220, 0),
      rect(904, 40, 984, 220, 0),
      // Hairline stems on columns 379 and 441 (x = 375 and 437 inside the inset box) and
      // 3px stems between them: the 1000x256 inset box has area 256000, so 4096 evenly
      // spaced offsets visit only 16 columns, 62-63px apart.
      rect(379, 120, 380, 144, 200),
      rect(441, 120, 442, 144, 200),
      glyphs(386, 120, 436, 144, 200, 3, 7),
    ]);
    const result = await check(image, { left: 0, top: 0, right: 1008, bottom: 264 });
    expect(result).not.toBeNull();
    expect(result!.textColor.r).toBe(200);
    expect(result!.meetsAA).toBe(false);
  });
});
