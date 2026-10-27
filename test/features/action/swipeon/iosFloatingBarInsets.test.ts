import { expect, test } from "bun:test";
import { deriveIosFloatingBarInsets } from "../../../../src/features/action/swipeon/iosFloatingBarInsets";
import { effectiveSwipeInsets } from "../../../../src/features/action/swipeon/iosChromeInsets";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { nodeAttributes } from "../../../../src/models/ViewHierarchyResult";
import capture from "../../../fixtures/ios-safari-url-field/hierarchy-compact.json";
import { viewHierarchyFromFixture, buildObserveResult } from "../../../helpers/observeFixture";
import { loadIosRemindersNoiseObservePair } from "../../../fixtures/observe/observeFixture";

const zero = { top: 0, right: 0, bottom: 0, left: 0 };
const hierarchy = viewHierarchyFromFixture(capture);

test("captured Safari capsule reserves 82 bottom points only", () => {
  expect(deriveIosFloatingBarInsets(hierarchy)).toEqual({ ...zero, bottom: 82 });
});
for (const [name, observation] of Object.entries(loadIosRemindersNoiseObservePair())) {
  test(`captured Reminders ${name} text field above toolbar contributes no floating inset`, () => {
    expect(deriveIosFloatingBarInsets(observation.viewHierarchy)).toEqual(zero);
  });
  test(`captured Reminders ${name} retains existing effective insets`, () => {
    expect(effectiveSwipeInsets({ observation, platform: "ios" })).toEqual({
      ...zero,
      top: 104,
      bottom: 80,
    });
  });
}
test("ignores captured capsule controls inside a scrollable ancestor", () => {
  const clone = structuredClone(hierarchy);
  const capsule = new SearchableHierarchy()
    .project(clone)
    .find((node) => node.nativeId === "CapsuleViewController")!;
  // Change only the captured capsule's scrollability to model content ownership.
  nodeAttributes(capsule.source).scrollable = "true";
  expect(deriveIosFloatingBarInsets(clone)).toEqual(zero);
});
test("Android retains observed insets even with Safari hierarchy", () => {
  const observation = buildObserveResult({
    viewHierarchy: hierarchy,
    updatedAt: 0,
    screenSize: { width: 402, height: 874 },
    systemInsets: zero,
  });
  expect(effectiveSwipeInsets({ observation, platform: "android" })).toEqual(zero);
});
test("missing hierarchy has zero floating insets", () => {
  expect(deriveIosFloatingBarInsets(undefined)).toEqual(zero);
});

for (const count of [1, 2]) {
  test(`captured Safari row reduced to ${count} controls reserves no floating band`, () => {
    const clone = structuredClone(hierarchy);
    const retained = ["BackButton", "TabOverviewButton"].slice(0, count);
    for (const node of new SearchableHierarchy().project(clone)) {
      if (
        node.bounds &&
        node.bounds.top >= 792 &&
        ["UIButton", "UITextField"].includes(node.className ?? "")
      ) {
        // Mutation of captured nodes: hide other controls and relabel Back as a lone CTA.
        nodeAttributes(node.source).visible = retained.includes(node.nativeId ?? "")
          ? "true"
          : "false";
        if (node.nativeId === "BackButton") {
          nodeAttributes(node.source).text = "Continue";
        }
      }
    }
    expect(deriveIosFloatingBarInsets(clone)).toEqual(zero);
  });
}

test("three captured controls on separate rows do not form a floating bar", () => {
  const clone = structuredClone(hierarchy);
  const ids = ["BackButton", "MoreMenuButton", "TabOverviewButton"];
  for (const node of new SearchableHierarchy().project(clone)) {
    if (
      node.bounds &&
      node.bounds.top >= 792 &&
      ["UIButton", "UITextField"].includes(node.className ?? "")
    ) {
      const index = ids.indexOf(node.nativeId ?? "");
      // Mutation of captured nodes: retain three controls, moving each to a distinct row.
      nodeAttributes(node.source).visible = index >= 0 ? "true" : "false";
      if (index >= 0) {
        node.source.bounds = { ...node.bounds, top: 720 + index * 50, bottom: 740 + index * 50 };
      }
    }
  }
  expect(deriveIosFloatingBarInsets(clone)).toEqual(zero);
});

test("exactly three captured controls sharing a row reserve the floating band", () => {
  const clone = structuredClone(hierarchy);
  for (const node of new SearchableHierarchy().project(clone)) {
    if (["TabBarItemTitle", "VoiceSearchButton"].includes(node.nativeId ?? "")) {
      // Mutation of captured nodes: neutralize two controls, leaving three on their captured row.
      nodeAttributes(node.source).visible = "false";
    }
  }
  expect(deriveIosFloatingBarInsets(clone)).toEqual({ ...zero, bottom: 82 });
});
