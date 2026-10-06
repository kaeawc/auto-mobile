import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import { textEquals } from "../../../src/features/observe/ConditionPredicates";
import { previewHierarchyHitTest } from "../../../src/features/observe/HierarchyHitTest";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import capturedIme from "../../fixtures/android-ime-window/playground-gboard-api36.json";
import { loadAndroidHomeObserve } from "../../fixtures/observe/observeFixture";

/**
 * #10095 (`shownText` on the searchable projection, read by waitFor `textEquals`) and #10097
 * (hit-test lists each node once, de-duplicating by `source`) both read the projection of the
 * captured linked-window hierarchy, which holds a node twice: once under the merged roots and
 * once under its owning window. They must agree on what such a node shows.
 */
describe("linked-window projection shared by waitFor textEquals and hitTest (#10095 + #10097)", () => {
  const hierarchy = new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    structuredClone(capturedIme) as AccessibilityHierarchy,
  );
  const observation: ObserveResult = {
    ...loadAndroidHomeObserve().observe,
    screenSize: { width: 1080, height: 2400 },
    viewHierarchy: hierarchy,
  };
  const entries = new SearchableHierarchy().project(hierarchy);
  const emailId = "s2-3d76c79e0f0c6c1d";

  test("every duplicated node projects the same shown text and label under both of its roots", () => {
    const bySource = Map.groupBy(entries, (entry) => entry.source);
    const duplicated = [...bySource.values()].filter((group) => group.length > 1);
    expect(duplicated.length).toBeGreaterThan(0);
    for (const group of duplicated) {
      expect(new Set(group.map((entry) => entry.shownText)).size).toBe(1);
      expect(new Set(group.map((entry) => entry.label)).size).toBe(1);
    }
  });

  test("textEquals matches a node that is held twice, and hitTest lists it once with that text", () => {
    const copies = entries.filter((entry) => entry.elementId === emailId);
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.every((entry) => entry.shownText === "Email")).toBe(true);

    expect(
      textEquals(new ElementResolver(), { elementId: emailId }, "Email")(observation).matched,
    ).toBe(true);

    const bounds = copies[0].bounds!;
    const result = previewHierarchyHitTest(
      {
        x: Math.floor((bounds.left + bounds.right) / 2),
        y: Math.floor((bounds.top + bounds.bottom) / 2),
      },
      observation,
      "android",
    );
    const listed = result.candidates.filter((entry) => entry.elementId === emailId);
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toBe("Email");
    expect(listed[0].windowRank).toBe(Math.min(...copies.map((entry) => entry.windowRank)));
  });
});
