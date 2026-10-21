import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

// Real Android 37 Settings home capture (manual-test batch 20261021d, #14738) under the ANR
// scrim; bounds are the title elements from the same observation.
const screenshot = path.join(
  import.meta.dir,
  "../../fixtures/accessibility-contrast/contrast-audit-settings-home-scrim-android37.png",
);
let checker: ContrastChecker;
beforeAll(async () => {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(await resolveImageBackend().rawPixels(readFileSync(screenshot)));
  checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
});

const title = (text: string, left: number, top: number, right: number, bottom: number): Element =>
  ({ text, bounds: { left, top, right, bottom } }) as Element;

describe("dark glyphs with anti-aliasing halos (#14738)", () => {
  test.each([
    title("Network & internet", 221, 655, 566, 712),
    title("Connected devices", 221, 852, 574, 909),
  ])("$text is sampled from its glyphs, not the halo beside the background", async (element) => {
    const result = await checker.checkContrast(screenshot, element, "AA", 420);
    expect(result).not.toBeNull();
    expect(result!.textColor).toEqual({ r: 19, g: 20, b: 23 });
    // The scrim dims the card, so the glyphs are legible but below 4.5:1; the halo read ~1.1:1.
    expect(result!.backgroundColor).toEqual({ r: 100, g: 99, b: 102 });
  });
});
