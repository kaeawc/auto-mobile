import { describe, expect, test } from "bun:test";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { describeIncompleteCapture } from "../../../src/features/observe/observationVerdict";
import { computeFreshness } from "../../../src/features/observe/observationFreshness";
import { observeResultSchema } from "../../../src/server/toolOutputSchemas";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { buildObserveResult } from "../../helpers/observeFixture";

const NOW = 1_700_000_000_000;

function skippedHierarchy(
  reason: "window_read_skipped" | "window_list_skipped",
  skipped: Pick<ViewHierarchyResult, "skippedWindowReads" | "skippedWindowIds"> = {},
): ViewHierarchyResult {
  return {
    hierarchy: {},
    ctrlProxyIncomplete: true,
    ctrlProxyIncompleteReason: reason,
    packageName: "com.example",
    ...skipped,
  };
}

function observation(viewHierarchy: ViewHierarchyResult) {
  return buildObserveResult({
    updatedAt: NOW,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy,
  });
}

describe("skipped window read over a readable app window", () => {
  test("default skeleton projection lifts ctrlProxyIncomplete, reason and skipped windows", () => {
    const projected = sanitizeObserveResult(
      observation(
        skippedHierarchy("window_read_skipped", { skippedWindowReads: 1, skippedWindowIds: [67] }),
      ),
      { dropElements: true, project: "skeleton" },
    );
    expect(projected.viewHierarchy).toBeUndefined();
    expect(projected.captureIncomplete).toEqual({
      ctrlProxyIncomplete: true,
      reason: "window_read_skipped",
      skippedWindowReads: 1,
      skippedWindowIds: [67],
    });
    expect(observeResultSchema.safeParse(projected).success).toBe(true);
  });

  test("the bare repro still carries the flag and reason through the projection", () => {
    const projected = sanitizeObserveResult(observation(skippedHierarchy("window_read_skipped")), {
      dropElements: true,
      project: "skeleton",
    });
    expect(projected.captureIncomplete).toEqual({
      ctrlProxyIncomplete: true,
      reason: "window_read_skipped",
    });
  });

  test("a complete capture carries no captureIncomplete", () => {
    const projected = sanitizeObserveResult(
      observation({ hierarchy: {}, packageName: "com.example" }),
      { dropElements: true, project: "skeleton" },
    );
    expect(projected).not.toHaveProperty("captureIncomplete");
  });

  test.each(["window_read_skipped", "window_list_skipped"] as const)(
    "%s is reported even when the package matches the foreground",
    (reason) => {
      const incompleteCapture = describeIncompleteCapture(
        skippedHierarchy(reason),
        "com.example",
        false,
      );
      expect(incompleteCapture).toMatchObject({ reason, foregroundRead: true });
      const verdict = computeFreshness({
        actualTimestamp: NOW,
        now: NOW,
        verified: true,
        incompleteCapture,
      });
      expect(verdict.isFresh).toBe(false);
      expect(verdict.verified).toBe(false);
      expect(verdict.warning).toContain("the focused application window was read");
      expect(verdict.warning).toContain("Observe again");
      expect(verdict.warning).toContain(
        reason === "window_list_skipped" ? "window listing read timed out" : "could not be read",
      );
      expect(verdict.warning).not.toContain("no root node");
      expect(verdict.warning).not.toContain("isAccessibilityTool");
    },
  );

  test("a null root under a matching foreground still does not retract freshness", () => {
    expect(
      describeIncompleteCapture(
        { hierarchy: {}, ctrlProxyIncomplete: true, packageName: "com.example" },
        "com.example",
        false,
      ),
    ).toBeUndefined();
  });
});
