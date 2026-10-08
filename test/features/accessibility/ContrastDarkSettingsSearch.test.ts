import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import type { RawImage } from "../../../src/utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured from Android Settings in dark theme with the keyboard up (2076x2152, 480dpi),
// together with the element bounds from the same observation (#10290). The "Search settings"
// hint sits in a ~2000px-wide field, so its glyphs are a tiny fraction of the box.
// The JPEG is the CtrlProxy observation screenshot the audit actually measured; the PNG is
// a lossless capture of the same screen taken moments earlier.
const fixtures = path.join(import.meta.dir, "../../fixtures/accessibility-contrast");
const captures = {
  "CtrlProxy JPEG": path.join(fixtures, "contrast-audit-settings-search-dark-kbup.jpg"),
  "lossless PNG": path.join(fixtures, "contrast-audit-settings-search-dark-kbup-lossless.png"),
};
const searchField: Element = {
  text: "Search settings",
  bounds: { left: 117, top: 136, right: 2076, bottom: 312 },
};
const searchExplanation: Element = {
  text: "Search settings",
  bounds: { left: 0, top: 491, right: 2076, bottom: 565 },
};

function checkerFor(image: RawImage): ContrastChecker {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(image);
  return new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
}

const decoded = new Map<string, RawImage>();
beforeAll(async () => {
  const backend = resolveImageBackend();
  for (const file of Object.values(captures)) {
    decoded.set(file, await backend.rawPixels(readFileSync(file)));
  }
});

for (const [name, screenshot] of Object.entries(captures)) {
  describe(`dark Settings search capture, ${name} (#10290)`, () => {
    test("sparse hint text in a wide field is measured against the field, not the field against itself", async () => {
      const result = await checkerFor(decoded.get(screenshot)!).checkContrast(
        screenshot,
        searchField,
        "AA",
        480,
      );

      expect(result).not.toBeNull();
      expect(result!.textColor.r).toBeGreaterThan(150);
      expect(result!.backgroundColor.r).toBeLessThan(60);
      expect(result!.minRatio).toBeGreaterThan(4.5);
      expect(result!.meetsAA).toBe(true);
    });

    test("a sample point that lands on a glyph stroke does not become a 1:1 background", async () => {
      const result = await checkerFor(decoded.get(screenshot)!).checkContrast(
        screenshot,
        searchExplanation,
        "AA",
        480,
      );

      expect(result).not.toBeNull();
      expect(result!.textColor.r).toBeGreaterThan(200);
      expect(result!.minRatio).toBeGreaterThan(10);
      expect(result!.meetsAA).toBe(true);
    });
  });
}

/**
 * A 900x120 element: faint "glyph" strokes (3px bars every 10px, about 1.15:1) and,
 * optionally, a solid high-contrast 60x60 icon to their left.
 */
function iconBesideFaintText(dark: boolean, icon: boolean): RawImage {
  const width = 900;
  const height = 120;
  const background = dark ? 30 : 255;
  const faint = dark ? 44 : 238;
  const iconInk = dark ? 240 : 0;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stroke = x >= 150 && x < 850 && y >= 40 && y < 80 && x % 10 < 3;
      const inIcon = icon && x >= 40 && x < 100 && y >= 30 && y < 90;
      const value = inIcon ? iconInk : stroke ? faint : background;
      data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { width, height, data };
}

describe("low-contrast text beside a high-contrast icon (#10290 regression)", () => {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    test(`${theme}: the icon does not hide the faint text`, async () => {
      const element: Element = {
        text: "label",
        bounds: { left: 0, top: 0, right: 900, bottom: 120 },
      };
      const alone = await checkerFor(iconBesideFaintText(dark, false)).checkContrast(
        "synthetic.png",
        element,
        "AA",
        420,
      );
      const withIcon = await checkerFor(iconBesideFaintText(dark, true)).checkContrast(
        "synthetic.png",
        element,
        "AA",
        420,
      );

      expect(alone!.meetsAA).toBe(false);
      expect(alone!.ratio).toBeLessThan(1.3);
      expect(withIcon!.textColor).toEqual(alone!.textColor);
      expect(withIcon!.ratio).toBeLessThan(1.3);
      expect(withIcon!.meetsAA).toBe(false);
    });
  }
});
