import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixtures = path.join(import.meta.dir, "../../fixtures");
const capturePath = path.join(fixtures, "accessibility-contrast/contrast-audit-kbdown-screen.png");
let captured: RawImage;
let fail: RawImage;
let black: RawImage;
let gradient: RawImage;

function crop(image: RawImage, bounds: Element["bounds"]): RawImage {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((bounds.top + y) * image.width + bounds.left) * 4;
    image.data.copy(data, y * width * 4, start, start + width * 4);
  }
  return { width, height, data };
}

function paste(target: RawImage, source: RawImage, left: number, top: number): void {
  for (let y = 0; y < source.height; y++) {
    source.data.copy(
      target.data,
      ((top + y) * target.width + left) * 4,
      y * source.width * 4,
      (y + 1) * source.width * 4,
    );
  }
}

function pixelChecker(image: RawImage, detectGradients = true): ContrastChecker {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(image);
  return new ContrastChecker(
    { enableElementCache: false, detectGradients },
    new FakeTimer(),
    backend,
    {
      readFile: async () => Buffer.from("predecoded real pixels"),
    },
  );
}

beforeAll(async () => {
  const backend = resolveImageBackend();
  [captured, fail, black, gradient] = await Promise.all([
    backend.rawPixels(readFileSync(capturePath)),
    backend.rawPixels(readFileSync(path.join(fixtures, "screenshots/wcag-aa-fail.png"))),
    backend.rawPixels(readFileSync(path.join(fixtures, "screenshots/black-on-white.png"))),
    backend.rawPixels(readFileSync(path.join(fixtures, "screenshots/gradient-contrast-fail.png"))),
  ]);
});

const emailBounds = { left: 84, top: 1304, right: 996, bottom: 1449 };
const titleBounds = { left: 42, top: 694, right: 1038, bottom: 779 };

// Copy only existing pixel crops; no painted colours or generated device hierarchy.
function outlinedField(): { image: RawImage; element: Element } {
  const image = crop(captured, { left: 42, top: 694, right: 202, bottom: 774 });
  // White margin from the existing fixture becomes the field fill. The dark capture remains its border/page.
  const white = crop(black, { left: 0, top: 0, right: 100, bottom: 5 });
  for (let y = 8; y < 73; y += 5) {
    paste(image, white, 8, y);
    paste(image, crop(white, { left: 0, top: 0, right: 44, bottom: 5 }), 108, y);
  }
  paste(image, crop(fail, { left: 8, top: 8, right: 92, bottom: 42 }), 30, 24);
  return {
    image,
    element: { text: "Sample", bounds: { left: 6, top: 6, right: 154, bottom: 78 }, textSize: 16 },
  };
}

function textBesideIcon(iconWidth: number): RawImage {
  const image = crop(fail, { left: 0, top: 0, right: 100, bottom: 50 });
  // A black decoration crop beside the fixture's real grey foreground, on its white fill.
  paste(image, crop(black, { left: 8, top: 8, right: 8 + iconWidth, bottom: 42 }), 8, 8);
  return image;
}

describe("review regressions using existing screenshot pixels", () => {
  test("captured bordered Email field measures its glyphs against its own fill", async () => {
    const image = crop(captured, emailBounds);
    const result = await pixelChecker(image).checkContrast(
      capturePath,
      {
        text: "Email",
        bounds: { left: 0, top: 0, right: image.width, bottom: image.height },
        textSize: 16,
      },
      "AA",
    );
    expect(result!.textColor).toEqual({ r: 243, g: 233, b: 219 });
    expect(result!.backgroundColor).toEqual({ r: 55, g: 47, b: 37 });
    expect(result!.meetsAA).toBe(true);
  });

  test("composited outlined grey field on a dark page stays a failure", async () => {
    const { image, element } = outlinedField();
    const result = await pixelChecker(image).checkContrast(capturePath, element, "AA");
    expect(result!.textColor).toEqual({ r: 170, g: 170, b: 170 });
    expect(result!.backgroundColor).toEqual({ r: 255, g: 255, b: 255 });
    expect(result!.ratio).toBeCloseTo(2.32, 2);
    expect(result!.meetsAA).toBe(false);
  });

  test("a composited border-coloured decoration cannot replace an outlined field fill", async () => {
    const { image, element } = outlinedField();
    // Replace the field's border with the same real black crop used by its icon.
    const strip = crop(black, { left: 8, top: 8, right: 92, bottom: 10 });
    paste(image, strip, 6, 6);
    paste(image, strip, 70, 6);
    paste(image, strip, 6, 76);
    paste(image, strip, 70, 76);
    const side = crop(black, { left: 8, top: 8, right: 10, bottom: 42 });
    for (const left of [6, 152]) {
      paste(image, side, left, 8);
      paste(image, side, left, 42);
    }
    paste(image, crop(black, { left: 8, top: 8, right: 68, bottom: 42 }), 30, 24);
    const result = await pixelChecker(image).checkContrast(capturePath, element, "AA");
    expect(result!.textColor).toEqual({ r: 170, g: 170, b: 170 });
    expect(result!.ratio).toBeLessThan(4.5);
    expect(result!.meetsAA).toBe(false);
  });

  for (const iconWidth of [8, 42, 60, 72]) {
    test(`composited ${iconWidth}px decoration cannot hide grey text failure`, async () => {
      const image = textBesideIcon(iconWidth);
      const result = await pixelChecker(image).checkContrast(
        capturePath,
        {
          text: "Sample",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          textSize: 16,
        },
        "AA",
      );
      expect(result!.textColor).toEqual({ r: 170, g: 170, b: 170 });
      expect(result!.meetsAA).toBe(false);
      expect(result!.ratio).toBeLessThan(4.5);
    });
  }

  test("composited captured eye icon cannot hide the grey fixture text", async () => {
    const image = crop(fail, { left: 0, top: 0, right: 100, bottom: 50 });
    paste(image, crop(captured, { left: 902, top: 1735, right: 962, bottom: 1771 }), 32, 8);
    const result = await pixelChecker(image).checkContrast(
      capturePath,
      {
        text: "Sample",
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        textSize: 16,
      },
      "AA",
    );
    expect(result!.ratio).toBeLessThanOrEqual(2.32);
    expect(result!.meetsAA).toBe(false);
  });

  test("mirrored real gradient pixels retain symmetric background variation", async () => {
    const image = crop(gradient, { left: 0, top: 0, right: 120, bottom: 60 });
    for (let y = 0; y < 60; y++) {
      const sourceY = 2 * Math.min(y, 59 - y);
      paste(
        image,
        crop(gradient, { left: 0, top: sourceY, right: 120, bottom: sourceY + 1 }),
        0,
        y,
      );
    }
    const result = await pixelChecker(image).checkContrast(
      capturePath,
      {
        text: "Gradient",
        bounds: { left: 0, top: 0, right: 120, bottom: 60 },
        textSize: 16,
      },
      "AA",
    );
    expect(result!.gradient).toBeUndefined();
    expect(result!.minRatio).toBeLessThan(result!.avgRatio);
    expect(result!.avgRatio).toBeLessThan(result!.maxRatio);
    expect(result!.meetsAA).toBe(false);
  });

  test("local variation survives with gradient detection disabled", async () => {
    const result = await pixelChecker(gradient, false).checkContrast(
      capturePath,
      {
        text: "Gradient",
        bounds: { left: 0, top: 0, right: 120, bottom: 60 },
        textSize: 16,
      },
      "AA",
    );
    expect(result!.gradient).toBeUndefined();
    expect(result!.minRatio).toBeLessThan(result!.avgRatio);
    expect(result!.avgRatio).toBeLessThan(result!.maxRatio);
    expect(result!.meetsAA).toBe(false);
  });

  test("the captured title still measures 15.68:1 without glyph-contaminated samples", async () => {
    const image = crop(captured, titleBounds);
    const result = await pixelChecker(image).checkContrast(
      capturePath,
      {
        text: "INPUT TEXT SCREEN",
        bounds: { left: 0, top: 0, right: image.width, bottom: image.height },
      },
      "AA",
      480,
    );
    expect(result!.ratio).toBeCloseTo(15.68, 2);
    expect(result!.minRatio).toBe(result!.maxRatio);
    expect(result!.meetsAA).toBe(true);
  });
});
