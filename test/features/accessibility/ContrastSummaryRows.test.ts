import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import type { Element } from "../../../src/models/Element";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

// Real Android 37 Settings home capture (manual-test batch 20261022a, #14738), light theme.
const screenshot = path.join(
  import.meta.dir,
  "../../fixtures/accessibility-contrast/contrast-audit-settings-home-light-summary-android37.png",
);
let checker: ContrastChecker;
beforeAll(async () => {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(await resolveImageBackend().rawPixels(readFileSync(screenshot)));
  checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
});

const row = (text: string, left: number, top: number, right: number, bottom: number): Element =>
  ({ text, bounds: { left, top, right, bottom } }) as Element;

describe("secondary summary rows keep their glyph colour (#14738)", () => {
  test.each([
    row("Notification history, conversations", 221, 1340, 777, 1391),
    row("Do Not Disturb, Bedtime, Transit", 221, 1734, 743, 1785),
    row("Display & touch", 221, 1874, 510, 1931),
  ])("$text is judged against its real glyphs", async (element) => {
    const result = await checker.checkContrast(screenshot, element, "AA", 420);
    expect(result).not.toBeNull();
    expect(result!.ratio).toBeGreaterThan(4.5);
  });
});
