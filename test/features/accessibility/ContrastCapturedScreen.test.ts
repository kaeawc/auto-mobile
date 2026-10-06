import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import { WcagAudit, type WcagBaselineStore } from "../../../src/features/accessibility/WcagAudit";
import { projectAuditElements } from "../../../src/features/accessibility/AuditElementProjection";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { resolveImageBackend } from "../../../src/utils/image/backend/resolveImageBackend";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixtures = path.join(import.meta.dir, "../../fixtures/accessibility-contrast");
const screenshot = path.join(fixtures, "contrast-audit-kbdown-screen.png");
interface CapturedElement extends Omit<Element, "bounds"> {
  bounds: [number, number, number, number];
}
function elements(name: string): Element[] {
  const captured: CapturedElement[] = JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
  return captured.map(({ bounds: [left, top, right, bottom], ...attributes }) => ({
    ...attributes,
    bounds: { left, top, right, bottom },
  }));
}
const appElements = elements("kbdown-elements.json");
const imeElements = elements("kbup-elements.json");
const config = { level: "AA", failureMode: "report", useBaseline: false } as const;
const noBaseline: WcagBaselineStore = {
  getBaseline: async () => null,
  saveBaseline: async () => {},
  clearBaseline: async () => {},
};
let checker: ContrastChecker;
beforeAll(async () => {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(await resolveImageBackend().rawPixels(readFileSync(screenshot)));
  checker = new ContrastChecker({ enableElementCache: false }, new FakeTimer(), backend, {
    readFile: async () => Buffer.from("predecoded capture"),
  });
});

describe("real dark-theme Playground capture", () => {
  for (const element of appElements) {
    test(`${element.text} at y=${element.bounds.top} uses glyph colour and passes AA`, async () => {
      const result = await checker.checkContrast(screenshot, element, "AA", 480);
      expect(result).not.toBeNull();
      expect(result!.textColor.r).toBeGreaterThan(130);
      expect(result!.textColor.g).toBeGreaterThan(100);
      expect(result!.textColor.r).toBeGreaterThan(result!.backgroundColor.r + 60);
      expect(result!.textColor).toEqual(
        element.text === "Tap"
          ? { r: 255, g: 138, b: 126 }
          : element.text === "Discover" && element.bounds.top === 2253
            ? { r: 143, g: 196, b: 245 }
            : { r: 243, g: 233, b: 219 },
      );
      expect(result!.gradient).toBeUndefined();
      expect(result!.meetsAA).toBe(true);
    });
  }
  test("the audit does not report the legible labels as insufficient contrast", async () => {
    const audit = new WcagAudit(new FakeTimer(), noBaseline, checker);
    const result = await audit.audit(
      appElements,
      { node: [] },
      screenshot,
      "playground",
      config,
      480,
    );
    expect(result.violations.filter((v) => v.type === "insufficient-contrast")).toEqual([]);
  });
});

describe("captured Gboard hints and keys", () => {
  const capture: ViewHierarchyResult = JSON.parse(
    readFileSync(path.join(fixtures, "../android-ime-window/playground-gboard-api36.json"), "utf8"),
  );
  const projection = projectAuditElements(capture);
  // Resolve ownership from another real capture's marked Gboard subtree, not from a package guess.
  const windowIds = new Map<Element, number>();
  for (const element of imeElements) {
    const match = projection.elements.find((e) => e["resource-id"] === element["resource-id"]);
    const id = match && projection.windowIds.get(match);
    if (id !== undefined) {
      windowIds.set(element, id);
    }
  }
  test("positive IME ownership excludes hints and keys from every violation check", async () => {
    expect(windowIds.size).toBe(imeElements.length);
    const audit = new WcagAudit(new FakeTimer(), noBaseline, checker);
    const result = await audit.audit(
      imeElements,
      capture.hierarchy,
      screenshot,
      "playground",
      config,
      {
        density: 480,
        windows: capture.windows,
        elementWindowIds: windowIds,
      },
    );
    expect(result.violations).toEqual([]);
  });
  test("a known application window takes precedence over the IME package fallback", async () => {
    const audit = new WcagAudit(new FakeTimer(), noBaseline, checker);
    const result = await audit.audit(
      imeElements,
      capture.hierarchy,
      undefined,
      "playground",
      config,
      {
        density: 480,
        windows: [
          { id: 1, type: 1 },
          { id: 2, type: 2, packageName: "com.google.android.inputmethod.latin" },
        ],
        elementWindowIds: new Map(imeElements.map((element) => [element, 1])),
      },
    );
    expect(result.violations.some((v) => v.type === "touch-target-too-small")).toBe(true);
  });
  test("authoritative IME window package identifies unmarked captured nodes", async () => {
    const audit = new WcagAudit(new FakeTimer(), noBaseline, checker);
    const result = await audit.audit(
      imeElements,
      capture.hierarchy,
      screenshot,
      "playground",
      config,
      {
        density: 480,
        windows: [{ type: 2, packageName: "com.google.android.inputmethod.latin" }],
      },
    );
    expect(result.violations).toEqual([]);
  });
  test("without positive IME ownership the same small keys remain audited", async () => {
    const audit = new WcagAudit(new FakeTimer(), noBaseline, checker);
    const result = await audit.audit(
      imeElements,
      capture.hierarchy,
      undefined,
      "playground",
      config,
      480,
    );
    expect(result.violations.some((v) => v.type === "touch-target-too-small")).toBe(true);
  });
});
