import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured from Android Settings in dark theme with the keyboard up (2076x2152, 480dpi),
// together with the element bounds from the same observation (#10290). The "Search settings"
// hint sits in a ~2000px-wide field, so its glyphs are a tiny fraction of the box.
const screenshot = path.join(
  import.meta.dir,
  "../../fixtures/accessibility-contrast/contrast-audit-settings-search-dark-kbup.jpg",
);
const searchField: Element = {
  text: "Search settings",
  bounds: { left: 117, top: 136, right: 2076, bottom: 312 },
};
const searchExplanation: Element = {
  text: "Search settings",
  bounds: { left: 0, top: 491, right: 2076, bottom: 565 },
};

let checker: ContrastChecker;
beforeAll(async () => {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(await resolveImageBackend().rawPixels(readFileSync(screenshot)));
  checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
});

describe("dark Settings search capture (#10290)", () => {
  test("sparse hint text in a wide field is measured against the field, not the field against itself", async () => {
    const result = await checker.checkContrast(screenshot, searchField, "AA", 480);

    expect(result).not.toBeNull();
    expect(result!.textColor.r).toBeGreaterThan(150);
    expect(result!.backgroundColor.r).toBeLessThan(60);
    expect(result!.minRatio).toBeGreaterThan(4.5);
    expect(result!.meetsAA).toBe(true);
  });

  test("a sample point that lands on a glyph stroke does not become a 1:1 background", async () => {
    const result = await checker.checkContrast(screenshot, searchExplanation, "AA", 480);

    expect(result).not.toBeNull();
    expect(result!.textColor.r).toBeGreaterThan(200);
    expect(result!.minRatio).toBeGreaterThan(10);
    expect(result!.meetsAA).toBe(true);
  });
});
