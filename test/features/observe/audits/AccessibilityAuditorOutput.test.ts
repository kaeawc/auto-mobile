import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { AccessibilityAuditor } from "../../../../src/features/observe/audits/AccessibilityAuditor";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "../../../../src/features/accessibility/WcagAudit";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../../src/models";
import type {
  AccessibilityAuditConfig,
  AccessibilityAuditResult,
} from "../../../../src/models/AccessibilityAudit";

const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };
const config: AccessibilityAuditConfig = {
  level: "AA",
  failureMode: "report",
  useBaseline: false,
};

/** Real device captures already committed for other suites. */
function loadCapture(relativePath: string): ObserveResult {
  return JSON.parse(
    readFileSync(`${import.meta.dir}/../../../fixtures/${relativePath}`, "utf8"),
  ) as ObserveResult;
}

async function auditCapture(observation: ObserveResult): Promise<AccessibilityAuditResult> {
  const auditor = new AccessibilityAuditor({
    device: androidDevice,
    getConfig: () => config,
    screenshotPathResolver: async () => undefined,
  });
  await auditor.run(observation, new NoOpPerformanceTracker());
  expect(observation.accessibilityAudit).toBeDefined();
  return observation.accessibilityAudit!;
}

function missingLabels(result: AccessibilityAuditResult) {
  return result.violations.filter((violation) => violation.type === "missing-content-description");
}

describe("AccessibilityAuditor: clickable containers labelled by descendant text", () => {
  test("a captured Playground screen with labelled clickable rows has no missing-label violations", async () => {
    // Six clickable rows/buttons here carry no text or content-desc of their own;
    // their label is the child TextView text TalkBack merges and announces.
    const result = await auditCapture(
      loadCapture("android-enabled/playground-disabled-control-api36.json"),
    );

    expect(missingLabels(result)).toEqual([]);
  });

  test("genuinely unlabeled controls in a captured recents screen are still flagged", async () => {
    // `task_view_single` rows are labelled by descendants; the 43px `icon`
    // buttons and the focusable `taskbar_view` have no label anywhere.
    const result = await auditCapture(
      loadCapture("android-launcher/launcher-recents-emulator-5602.json"),
    );

    const flagged = missingLabels(result).map((violation) => violation.element["resource-id"]);
    expect(flagged.filter((id) => id?.endsWith(":id/task_view_single"))).toEqual([]);
    expect(flagged.filter((id) => id?.endsWith(":id/icon"))).toHaveLength(3);
    expect(flagged.filter((id) => id?.endsWith(":id/taskbar_view"))).toHaveLength(1);
  });
});

describe("AccessibilityAuditor: bounded violations", () => {
  function denseCapture(): ObserveResult {
    // This capture is a bare hierarchy (Playground with Gboard open). A very high
    // density makes nearly every clickable "too small", the pathological
    // many-violations screen the cap exists for.
    const hierarchy = JSON.parse(
      readFileSync(
        `${import.meta.dir}/../../../fixtures/android-ime-window/playground-gboard-api36.json`,
        "utf8",
      ),
    ) as ViewHierarchyResult;
    return {
      updatedAt: "2026-01-01T00:00:00.000Z",
      screenSize: { width: hierarchy.screenWidth ?? 1080, height: hierarchy.screenHeight ?? 2400 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      activeWindow: { appId: hierarchy.packageName ?? "dev.jasonpearson.automobile.playground" },
      viewHierarchy: { ...hierarchy, density: 1600 },
    } as ObserveResult;
  }

  test("caps the list, keeps errors first, and reports total/omitted per rule", async () => {
    const result = await auditCapture(denseCapture());

    const total = result.summary.bySeverity.error + result.summary.bySeverity.warning;
    expect(total).toBeGreaterThan(MAX_ACCESSIBILITY_VIOLATIONS);
    expect(result.violations).toHaveLength(MAX_ACCESSIBILITY_VIOLATIONS);

    const truncated = result.violationsTruncated!;
    expect(truncated.total).toBe(total);
    expect(truncated.omitted).toBe(total - MAX_ACCESSIBILITY_VIOLATIONS);
    expect(Object.values(truncated.omittedByType).reduce((sum, n) => sum + n, 0)).toBe(
      truncated.omitted,
    );
    // Dropped warnings are touch targets; per-rule omitted + kept == per-rule total.
    for (const [type, omitted] of Object.entries(truncated.omittedByType)) {
      const kept = result.violations.filter((violation) => violation.type === type).length;
      expect(kept + omitted).toBe(
        result.summary.byType[type as keyof typeof result.summary.byType],
      );
    }

    // Most severe first: every error is kept, and none follows a warning.
    const severities = result.violations.map((violation) => violation.severity);
    expect(severities.filter((severity) => severity === "error")).toHaveLength(
      result.summary.bySeverity.error,
    );
    expect(severities.indexOf("warning")).toBeGreaterThan(severities.lastIndexOf("error"));
  });

  test("summary counts the full set, not the capped list", async () => {
    const result = await auditCapture(denseCapture());

    expect(result.summary.byType["touch-target-too-small"]).toBeGreaterThan(
      result.violations.filter((violation) => violation.type === "touch-target-too-small").length,
    );
  });

  test("an under-cap screen is returned complete with no truncation marker", async () => {
    const result = await auditCapture(
      loadCapture("android-enabled/playground-disabled-control-api36.json"),
    );

    expect(result.violationsTruncated).toBeUndefined();
    expect(result.violations).toHaveLength(
      result.summary.bySeverity.error +
        result.summary.bySeverity.warning +
        result.summary.bySeverity.info,
    );
  });
});
