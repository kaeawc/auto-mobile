/**
 * The contrast check only measures text the screenshot actually shows (#10220).
 *
 * The hierarchy is a committed device capture (Playground with Gboard open: app window 548, the
 * keyboard window 550 over y 1517..2400, status bar 537). The screenshot is a synthetic raster the
 * size of that capture, served through the ContrastChecker's ImageBackend/readFile seam.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { WcagAudit, type WcagBaselineStore } from "../../../src/features/accessibility/WcagAudit";
import { ContrastChecker } from "../../../src/features/accessibility/ContrastChecker";
import { projectAuditElements } from "../../../src/features/accessibility/AuditElementProjection";
import { isContrastObservable } from "../../../src/features/accessibility/ContrastCoverage";
import type { AccessibilityAuditConfig } from "../../../src/models/AccessibilityAudit";
import type { Element } from "../../../src/models/Element";
import type {
  ViewHierarchyResult,
  ViewHierarchyNode,
  ViewHierarchyWindowInfo,
} from "../../../src/models/ViewHierarchyResult";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

const FIXTURE = path.join(
  import.meta.dir,
  "../../fixtures/android-ime-window/playground-gboard-api36.json",
);
const SCREENSHOT = "/synthetic/observation.png";
const WIDTH = 1080;
const HEIGHT = 2400;
const KEYBOARD_TOP = 1517;
const config: AccessibilityAuditConfig = { level: "AA", failureMode: "report", useBaseline: false };
const noBaseline: WcagBaselineStore = {
  getBaseline: async () => null,
  saveBaseline: async () => {},
  clearBaseline: async () => {},
};

function capture(): ViewHierarchyResult {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as ViewHierarchyResult;
}

interface Paint {
  rect: { left: number; top: number; right: number; bottom: number };
  value: number;
}

/** A WIDTH x HEIGHT raster of one grey level with solid rectangles painted over it. */
function raster(width: number, height: number, background: number, paints: Paint[] = []) {
  const data = Buffer.alloc(width * height * 4, background);
  for (const { rect, value } of paints) {
    for (let y = rect.top; y < rect.bottom; y++) {
      data.fill(value, (y * width + rect.left) * 4, (y * width + rect.right) * 4);
    }
  }
  return { width, height, data };
}

function auditWith(image: ReturnType<typeof raster>) {
  const backend = new FakeImageBackend();
  backend.setRawPixelsResult(image);
  const timer = new FakeTimer();
  const checker = new ContrastChecker({}, timer, backend, {
    readFile: async () => Buffer.from("synthetic screenshot"),
  });
  return new WcagAudit(timer, noBaseline, checker);
}

async function runAudit(hierarchy: ViewHierarchyResult, image: ReturnType<typeof raster>) {
  const projection = projectAuditElements(hierarchy);
  const result = await auditWith(image).audit(
    projection.elements,
    hierarchy.hierarchy,
    SCREENSHOT,
    "dev.jasonpearson.automobile.playground",
    config,
    {
      density: hierarchy.density,
      windows: hierarchy.windows,
      descendantLabelled: projection.descendantLabelled,
      elementWindowIds: projection.windowIds,
    },
  );
  const failing = result.violations
    .filter((violation) => violation.type === "insufficient-contrast")
    .map((violation) => violation.element);
  return { result, failing, projection };
}

const textsOf = (elements: Element[]) => elements.map((element) => element.text);
const isUnderKeyboard = (element: Element) => element.bounds.bottom > KEYBOARD_TOP;
const appTextUnderKeyboard = ["Password Field", "Password", "Multiline Text Area"];
const bottomNavLabels = ["Demos", "Slides", "Settings"];

describe("text under the soft keyboard (#10220)", () => {
  // Same colour everywhere: any text the screenshot shows has a 1:1 ratio and fails.
  const grey = () => raster(WIDTH, HEIGHT, 0x80);

  test("is not measured against keyboard pixels, and is reported as not evaluated", async () => {
    const { result, failing } = await runAudit(capture(), grey());

    const covered = failing.filter((element) => element.bounds.top >= KEYBOARD_TOP);
    // IME labels belong to the keyboard, while the app labels here are covered by it.
    expect(covered).toEqual([]);
    const failingTexts = textsOf(failing);
    for (const hidden of [...appTextUnderKeyboard, ...bottomNavLabels]) {
      expect(failingTexts).not.toContain(hidden);
    }
    expect(failing.some((e) => e.text === "Discover" && e.bounds.top > KEYBOARD_TOP)).toBe(false);
    expect(result.summary.notEvaluated).toEqual([
      {
        check: "insufficient-contrast",
        reason:
          "7 text elements are covered by the keyboard or another window, or partly hidden, so the screenshot does not show them",
      },
    ]);
  });

  test("a fully visible low-contrast label still fails (pin)", async () => {
    const { failing } = await runAudit(capture(), grey());

    expect(textsOf(failing)).toContain("Basic Text Field");
    expect(failing.filter((element) => !isUnderKeyboard(element)).length).toBeGreaterThan(5);
  });

  test("a fully visible passing label still passes (pin)", async () => {
    // Black text pixels in the middle of "Basic Text Field" on white: 21:1.
    const image = raster(WIDTH, HEIGHT, 0xff, [
      { rect: { left: 226, top: 1147, right: 276, bottom: 1167 }, value: 0x00 },
    ]);

    const { failing } = await runAudit(capture(), image);

    expect(textsOf(failing)).not.toContain("Basic Text Field");
    expect(textsOf(failing)).toContain("Email");
  });

  test("without a keyboard window the same labels are measured, so the skip comes from the window", async () => {
    const hierarchy = capture();
    hierarchy.windows = hierarchy.windows?.filter((window) => window.type !== 2);

    const { result, failing } = await runAudit(hierarchy, grey());

    expect(textsOf(failing)).toEqual(expect.arrayContaining(appTextUnderKeyboard));
    expect(result.summary.notEvaluated).toBeUndefined();
  });
});

describe("partially occluded text (#10220)", () => {
  function withPartialOcclusion(text: string): ViewHierarchyResult {
    const hierarchy = capture();
    const visit = (node: ViewHierarchyNode | undefined): void => {
      if (!node) {
        return;
      }
      if (node.text === text) {
        node.occlusionState = "partial";
        node.occludedBy = "dialog";
      }
      [node.node ?? []].flat().forEach(visit);
    };
    visit(hierarchy.hierarchy as ViewHierarchyNode);
    return hierarchy;
  }

  test("a node the device marked partially occluded is not sampled", async () => {
    // No keyboard window: the only reason to skip "Email" is the device's occlusion mark.
    const hierarchy = withPartialOcclusion("Email");
    hierarchy.windows = hierarchy.windows?.filter((window) => window.type !== 2);

    const { result, failing } = await runAudit(hierarchy, raster(WIDTH, HEIGHT, 0x80));

    expect(textsOf(failing)).not.toContain("Email");
    expect(textsOf(failing)).toContain("Basic Text Field");
    expect(result.summary.notEvaluated).toEqual([
      {
        check: "insufficient-contrast",
        reason: expect.stringMatching(/^1 text elements are covered by the keyboard or another/),
      },
    ]);
  });
});

describe("text outside the screenshot (#10220)", () => {
  test("is not clamped to the edge pixel: it is reported as not evaluated", async () => {
    // A raster shorter than the capture: everything below y=1200 is outside it.
    const hierarchy = capture();
    hierarchy.windows = hierarchy.windows?.filter((window) => window.type !== 2);

    const { result, failing } = await runAudit(hierarchy, raster(WIDTH, 1200, 0x80));

    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((element) => element.bounds.bottom <= 1200)).toBe(true);
    expect(result.summary.notEvaluated).toEqual([
      {
        check: "insufficient-contrast",
        reason: expect.stringMatching(/^\d+ text elements extend beyond the screenshot$/),
      },
    ]);
  });
});

describe("isContrastObservable", () => {
  const window = (
    id: number,
    type: number,
    windowLayer: number,
    bounds: { left: number; top: number; right: number; bottom: number },
  ): ViewHierarchyWindowInfo => ({ id, type, windowLayer, bounds });
  const app = window(1, 1, 0, { left: 0, top: 0, right: 1080, bottom: 2400 });
  const ime = window(2, 2, 1, { left: 0, top: 1500, right: 1080, bottom: 2400 });
  const label = (top: number, bottom: number): Element => ({
    bounds: { left: 100, top, right: 400, bottom },
    text: "Label",
  });

  test("the keyboard covers app text it overlaps, not text above it or its own keys", () => {
    expect(isContrastObservable(label(1600, 1650), 1, [app, ime])).toBe(false);
    expect(isContrastObservable(label(1450, 1500), 1, [app, ime])).toBe(true);
    expect(isContrastObservable(label(1600, 1650), 2, [app, ime])).toBe(true);
  });

  test("a window whose own window is unknown can only be proven covered by the keyboard", () => {
    const dialog = window(3, 1, 5, { left: 0, top: 0, right: 1080, bottom: 2400 });

    expect(isContrastObservable(label(1600, 1650), undefined, [app, ime])).toBe(false);
    expect(isContrastObservable(label(100, 150), undefined, [app, dialog])).toBe(true);
  });

  test("an application window layered above (a dialog or popup) covers text under it", () => {
    const popup = window(3, 1, 4, { left: 0, top: 200, right: 600, bottom: 500 });

    expect(isContrastObservable(label(300, 350), 1, [app, popup])).toBe(false);
    expect(isContrastObservable(label(600, 650), 1, [app, popup])).toBe(true);
    expect(isContrastObservable(label(300, 350), 3, [app, popup])).toBe(true);
    // A window below the element's own never covers it.
    expect(isContrastObservable(label(300, 350), 3, [window(9, 1, 2, popup.bounds!), popup])).toBe(
      true,
    );
  });

  test("accessibility overlays and windows without bounds never cover app text", () => {
    const overlay = window(4, 4, 9, { left: 0, top: 0, right: 1080, bottom: 2400 });
    const unbounded: ViewHierarchyWindowInfo = { id: 5, type: 2, windowLayer: 8 };

    expect(isContrastObservable(label(300, 350), 1, [app, overlay, unbounded])).toBe(true);
  });

  test("the device's partial and hidden occlusion marks exclude the element", () => {
    expect(isContrastObservable({ ...label(300, 350), occlusionState: "partial" }, 1, [app])).toBe(
      false,
    );
    expect(isContrastObservable({ ...label(300, 350), occlusionState: "hidden" }, 1, [app])).toBe(
      false,
    );
    expect(isContrastObservable(label(300, 350), 1, [app])).toBe(true);
    expect(isContrastObservable(label(300, 350), undefined)).toBe(true);
  });

  test("captured windows: the projection ties app text to window 548 and keys to 550", () => {
    const hierarchy = capture();
    const { elements, windowIds } = projectAuditElements(hierarchy);
    const byText = (text: string) => elements.find((element) => element.text === text)!;

    expect(windowIds.get(byText("Basic Text Field"))).toBe(548);
    expect(windowIds.get(byText("5"))).toBe(550);
    expect(isContrastObservable(byText("Multiline Text Area"), 548, hierarchy.windows ?? [])).toBe(
      false,
    );
    expect(isContrastObservable(byText("5"), 550, hierarchy.windows ?? [])).toBe(true);
  });
});
