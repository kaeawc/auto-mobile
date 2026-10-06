import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WcagAudit,
  type WcagBaselineStore,
} from "../../../../src/features/accessibility/WcagAudit";
import { ContrastChecker } from "../../../../src/features/accessibility/ContrastChecker";
import { resolveImageBackend } from "../../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../../fakes/FakeImageBackend";
import { FakeTimer } from "../../../fakes/FakeTimer";

const fixtures = path.join(import.meta.dir, "../../../fixtures");
const screenshot = path.join(fixtures, "screenshots/wcag-aa-fail.png");
const noBaseline: WcagBaselineStore = {
  getBaseline: async () => null,
  saveBaseline: async () => {},
  clearBaseline: async () => {},
};
let checker: ContrastChecker;
beforeAll(async () => {
  const backend = resolveImageBackend();
  const image = await backend.rawPixels(readFileSync(screenshot));
  const captured = await backend.rawPixels(
    readFileSync(path.join(fixtures, "accessibility-contrast/contrast-audit-kbdown-screen.png")),
  );
  // Composite the captured password eye beside the grey foreground of the existing
  // contrast fixture. Copy complete pixel crops, including their original backgrounds.
  for (let y = 0; y < 36; y++) {
    const start = ((1735 + y) * captured.width + 902) * 4;
    captured.data.copy(image.data, ((8 + y) * image.width + 32) * 4, start, start + 60 * 4);
  }
  const fake = new FakeImageBackend();
  fake.setRawPixelsResult(image);
  checker = new ContrastChecker({}, new FakeTimer(), fake, {
    readFile: async () => Buffer.from("predecoded real crops"),
  });
});

test("audit reports the grey foreground failure despite a composited captured icon", async () => {
  const result = await new WcagAudit(new FakeTimer(), noBaseline, checker).audit(
    [{ text: "Sample", bounds: { left: 0, top: 0, right: 100, bottom: 50 }, textSize: 16 }],
    { node: [] },
    screenshot,
    "real-pixel-composite",
    { level: "AA", failureMode: "report", useBaseline: false },
    160,
  );
  const violations = result.violations.filter(
    (violation) => violation.type === "insufficient-contrast",
  );
  expect(violations).toHaveLength(1);
  expect(violations[0].details?.contrastRatio).toBeLessThan(4.5);
  expect(violations[0].details?.contrastRatio).toBeLessThanOrEqual(2.32);
  expect(result.summary.byType["insufficient-contrast"]).toBe(1);
});
