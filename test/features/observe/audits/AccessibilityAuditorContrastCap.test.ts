/**
 * Interaction tests across the audit's three recent changes: the per-observation
 * contrast screenshot (#10037), the dp large-text rule (#10039), the violation
 * cap, and descendant-labelled clickable containers. Each is covered alone
 * elsewhere; these pin how they compose on real captured hierarchies.
 *
 * Hierarchies are committed device captures. The screenshot is a uniform grey
 * raster the size of the capture, served through the ContrastChecker's
 * ImageBackend seam: text and background are the same colour, so each text node
 * that the screenshot can show is a deterministic contrast failure. That is what
 * these tests need (a contrast failure per text node); they do not assert pixel
 * ratios. (A raster smaller than the capture no longer yields measurements:
 * bounds outside the image are not evaluated, #10220.)
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import {
  AccessibilityAuditor,
  resolveObservationScreenshotPath,
} from "../../../../src/features/observe/audits/AccessibilityAuditor";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "../../../../src/features/accessibility/WcagAudit";
import { InMemoryScreenshotStateStore } from "../../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { ContrastChecker } from "../../../../src/features/accessibility/ContrastChecker";
import { FakeImageBackend } from "../../../fakes/FakeImageBackend";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../../src/models";
import type {
  AccessibilityAuditConfig,
  AccessibilityAuditResult,
} from "../../../../src/models/AccessibilityAudit";

const fixtures = path.join(import.meta.dir, "../../../fixtures");
const screenshot = path.join(fixtures, "screenshots/wcag-aa-fail.png");
const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };
const config: AccessibilityAuditConfig = {
  level: "AA",
  failureMode: "report",
  useBaseline: false,
};

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(fixtures, relativePath), "utf8")) as T;
}

let gboardHierarchy: ViewHierarchyResult;
let imageBackend: FakeImageBackend;

beforeAll(() => {
  gboardHierarchy = readFixture<ViewHierarchyResult>(
    "android-ime-window/playground-gboard-api36.json",
  );
  // Three copies are needed to exceed the cap only when contrast is included.
  gboardHierarchy.density = 1600;
  const nodes = gboardHierarchy.hierarchy.node ?? [];
  gboardHierarchy.hierarchy.node = Array.from({ length: 3 }, () => structuredClone(nodes)).flat();
  imageBackend = new FakeImageBackend();
  imageBackend.setRawPixelsResult({
    width: 1080,
    height: 2400,
    data: Buffer.alloc(1080 * 2400 * 4, 0x80),
  });
});

/** A bare hierarchy capture (Playground with Gboard open) wrapped as an observation. */
function gboardObservation(observationId: string): ObserveResult {
  const hierarchy = gboardHierarchy;
  return {
    observationId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: hierarchy.screenWidth ?? 1080, height: hierarchy.screenHeight ?? 2400 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: hierarchy.packageName ?? "dev.jasonpearson.automobile.playground" },
    viewHierarchy: hierarchy,
  } as ObserveResult;
}

/** The captured Playground screen whose buttons are labelled only by child text. */
function playgroundButtonsObservation(density?: number): ObserveResult {
  const observation = readFixture<ObserveResult>(
    "android-enabled/playground-disabled-control-api36.json",
  );
  if (density !== undefined) {
    observation.viewHierarchy = { ...observation.viewHierarchy!, density };
  }
  return observation;
}

/**
 * Wires the production resolver chain (per-observation store path -> existence
 * check). Only `capturedObservationId` has a recorded screenshot, while the
 * device-wide "latest" points at the same file, as it would after another capture.
 */
function auditorWithCaptureFor(capturedObservationId: string): AccessibilityAuditor {
  const store = new InMemoryScreenshotStateStore(new FakeTimer());
  store.update(androidDevice.deviceId, screenshot);
  store.updateForObservation(androidDevice.deviceId, capturedObservationId, screenshot);
  return new AccessibilityAuditor({
    device: androidDevice,
    getConfig: () => config,
    contrastChecker: new ContrastChecker({}, new FakeTimer(), imageBackend, {
      readFile: async () => Buffer.from("synthetic screenshot"),
    }),
    screenshotPathResolver: (observationId) =>
      resolveObservationScreenshotPath(
        store.getPathForObservation(androidDevice.deviceId, observationId),
      ),
  });
}

async function audit(
  auditor: AccessibilityAuditor,
  observation: ObserveResult,
): Promise<AccessibilityAuditResult> {
  await auditor.run(observation, new NoOpPerformanceTracker());
  expect(observation.accessibilityAudit).toBeDefined();
  return observation.accessibilityAudit!;
}

function countOf(result: AccessibilityAuditResult, type: string): number {
  return result.violations.filter((violation) => violation.type === type).length;
}

function severityTotal(result: AccessibilityAuditResult): number {
  const { error, warning, info } = result.summary.bySeverity;
  return error + warning + info;
}

describe("contrast violations feed the cap, and summary counts reconcile", () => {
  test("the cap is applied after contrast violations from this observation's screenshot", async () => {
    const auditor = auditorWithCaptureFor("obs-A");

    const withShot = await audit(auditor, gboardObservation("obs-A"));
    const withoutShot = await audit(auditor, gboardObservation("obs-B"));

    // Contrast is what pushes this screen over the cap: without it the same
    // hierarchy is complete, with it the list is trimmed.
    const contrastTotal = withShot.summary.byType["insufficient-contrast"];
    expect(contrastTotal).toBeGreaterThan(0);
    expect(withoutShot.violationsTruncated).toBeUndefined();
    expect(withoutShot.violations).toHaveLength(severityTotal(withoutShot));
    expect(severityTotal(withShot)).toBe(severityTotal(withoutShot) + contrastTotal);
    expect(severityTotal(withShot)).toBeGreaterThan(MAX_ACCESSIBILITY_VIOLATIONS);

    expect(withShot.violations).toHaveLength(MAX_ACCESSIBILITY_VIOLATIONS);
    expect(withShot.violationsTruncated?.total).toBe(severityTotal(withShot));
  });

  test("errors (contrast) outrank warnings, so contrast failures survive the trim", async () => {
    const result = await audit(auditorWithCaptureFor("obs-A"), gboardObservation("obs-A"));

    // Precondition for "every error is kept": errors fit under the cap.
    expect(result.summary.bySeverity.error).toBeLessThanOrEqual(MAX_ACCESSIBILITY_VIOLATIONS);
    expect(countOf(result, "insufficient-contrast")).toBe(
      result.summary.byType["insufficient-contrast"],
    );
    expect(result.violationsTruncated?.omittedByType["insufficient-contrast"]).toBeUndefined();
    expect(result.violationsTruncated?.omittedByType["touch-target-too-small"]).toBeGreaterThan(0);
  });

  test("summary counts, kept violations and omitted counts reconcile per rule and per severity", async () => {
    const result = await audit(auditorWithCaptureFor("obs-A"), gboardObservation("obs-A"));
    const truncated = result.violationsTruncated!;

    for (const [type, total] of Object.entries(result.summary.byType)) {
      expect(
        countOf(result, type) +
          (truncated.omittedByType[type as keyof typeof result.summary.byType] ?? 0),
      ).toBe(total);
    }
    expect(result.violations.length + truncated.omitted).toBe(truncated.total);
    expect(truncated.total).toBe(severityTotal(result));
    expect(truncated.total).toBe(
      Object.values(result.summary.byType).reduce((sum, n) => sum + n, 0),
    );
    // The capped list never claims a clean pass the full set would not: the repeated app labels
    // under the open keyboard are reported as not evaluated, not measured against keyboard pixels.
    expect(result.summary.notEvaluated).toEqual([
      {
        check: "insufficient-contrast",
        reason: expect.stringMatching(/^21 text elements are covered by the keyboard/),
      },
    ]);
  });
});

describe("descendant-labelled clickable containers still get contrast-checked", () => {
  function contrastRequirements(result: AccessibilityAuditResult): Map<string, number | undefined> {
    return new Map(
      result.violations
        .filter((violation) => violation.type === "insufficient-contrast")
        .map((violation) => [violation.element.text ?? "", violation.details?.requiredRatio]),
    );
  }

  const buttonLabels = ["Primary Button", "Secondary Button", "Outlined Button", "Text Button"];

  test("child text is checked with the normal-text ratio at the captured density (49px = ~19dp)", async () => {
    const result = await audit(
      auditorWithCaptureFor("7de81117-a1b0-487a-b61d-c59a73e8747d"),
      playgroundButtonsObservation(),
    );

    // The clickable button containers have no label of their own and are not flagged...
    expect(countOf(result, "missing-content-description")).toBe(0);
    // ...but their text children are contrast-checked, in dp, not raw pixels.
    const required = contrastRequirements(result);
    for (const label of buttonLabels) {
      expect(required.get(label)).toBe(4.5);
    }
    // A 99px (~38dp) heading in the same capture is large text.
    expect(required.get("Typography")).toBe(3);
  });

  test("child text in a tap-target-sized (49dp) box stays normal text when no text size is reported", async () => {
    const result = await audit(
      auditorWithCaptureFor("7de81117-a1b0-487a-b61d-c59a73e8747d"),
      playgroundButtonsObservation(160),
    );

    expect(countOf(result, "missing-content-description")).toBe(0);
    const required = contrastRequirements(result);
    for (const label of buttonLabels) {
      expect(required.get(label)).toBe(4.5);
    }
  });
});

describe("an observation with no usable screenshot", () => {
  test("yields no contrast violations, says so, and is not truncated", async () => {
    // The device-wide latest capture exists (another observation's), but this one has none.
    const result = await audit(auditorWithCaptureFor("obs-A"), gboardObservation("obs-B"));

    expect(result.summary.byType["insufficient-contrast"]).toBe(0);
    expect(countOf(result, "insufficient-contrast")).toBe(0);
    expect(result.summary.notEvaluated).toEqual([
      { check: "insufficient-contrast", reason: "no screenshot for this observation" },
    ]);
    expect(result.violationsTruncated).toBeUndefined();
    expect(result.violations).toHaveLength(severityTotal(result));
  });

  test("a recorded screenshot whose file is gone is treated the same way", async () => {
    const store = new InMemoryScreenshotStateStore(new FakeTimer());
    store.updateForObservation(
      androidDevice.deviceId,
      "obs-B",
      path.join(fixtures, "screenshots/no-such-capture.png"),
    );
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => config,
      screenshotPathResolver: (observationId) =>
        resolveObservationScreenshotPath(
          store.getPathForObservation(androidDevice.deviceId, observationId),
        ),
    });

    const result = await audit(auditor, gboardObservation("obs-B"));

    expect(result.summary.byType["insufficient-contrast"]).toBe(0);
    expect(result.summary.notEvaluated).toHaveLength(1);
    expect(result.violationsTruncated).toBeUndefined();
  });

  test("a many-violation screen without a screenshot still truncates only the non-contrast rules", async () => {
    const observation = gboardObservation("obs-B");
    observation.viewHierarchy = { ...observation.viewHierarchy!, density: 1600 };

    const result = await audit(auditorWithCaptureFor("obs-A"), observation);

    expect(result.summary.byType["insufficient-contrast"]).toBe(0);
    expect(result.violationsTruncated?.omittedByType["insufficient-contrast"]).toBeUndefined();
    expect(result.summary.notEvaluated).toHaveLength(1);
  });
});
