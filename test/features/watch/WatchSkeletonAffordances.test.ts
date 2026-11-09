import { expect, test } from "bun:test";
import { normalizeWatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
// Captured from the watch runner (watchOS simulator), used unmodified unless a test clones it.
import textEntry from "../../fixtures/watchos-xcuitest/text-entry-field-empty.json";
import permissionAlert from "../../fixtures/watchos-xcuitest/notification-permission-alert.json";
import liveSdk from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";

/** The default observe projection path for a watch: iOS element model + iOS skeleton options. */
function project(hierarchy: unknown) {
  const viewHierarchy = normalizeWatchHierarchy(hierarchy);
  const elements = new ObserveElementsBuilder().build(viewHierarchy, "ios");
  if (!elements) {
    throw new Error("captured watch hierarchy produced no observe elements");
  }
  return projectSkeleton(
    elements,
    { width: viewHierarchy.screenWidth!, height: viewHierarchy.screenHeight! },
    undefined,
    { ios: true, iosHierarchy: viewHierarchy },
  );
}

test("pins the default skeleton for the captured watch text-entry screen (#17548)", () => {
  expect(project(textEntry)).toEqual({
    keyboard: undefined,
    skeleton: [
      { bounds: [14, 18, 50, 53], affordances: ["tap"], elementId: "BackButton", label: "Back" },
      {
        bounds: [2, 104, 206, 156],
        affordances: ["tap", "input"],
        elementId: "watch-text-field",
        label: "Text",
      },
    ],
    context: [{ bounds: [0, 0, 208, 248], affordances: [], label: "CtrlProxyWatch" }],
  });
});

test("gives captured watch alert cells and buttons tap, and the table scroll", () => {
  const { skeleton } = project(permissionAlert.data);
  expect(skeleton).toContainEqual({
    bounds: [0, 203, 187, 250],
    affordances: ["tap"],
    label: "Don’t Allow",
  });
  expect(skeleton).toContainEqual({
    bounds: [51, 212, 135, 235],
    affordances: ["tap"],
    label: "Don’t Allow",
  });
  expect(
    skeleton.some(
      (row) => row.affordances.includes("scroll") && row.bounds.join() === "0,0,187,223",
    ),
  ).toBe(true);
});

test("keeps static text and containers on a captured watch screen non-actionable", () => {
  const { skeleton, context } = project(liveSdk);
  expect(skeleton).toEqual([]);
  expect(context?.map((row) => row.elementId).filter(Boolean)).toEqual([
    "ctrlproxy-crown",
    "ctrlproxy-crown-value",
    "ctrlproxy-non-hittable",
  ]);
});

test("does not advertise tap or input on a disabled watch control", () => {
  const tree = structuredClone(textEntry);
  const disable = (node: { accessibilityIdentifier?: string; children?: unknown[] }): void => {
    if (["BackButton", "watch-text-field"].includes(node.accessibilityIdentifier ?? "")) {
      Object.assign(node, { isUserInteractionEnabled: false });
    }
    (node.children as (typeof node)[] | undefined)?.forEach(disable);
  };
  disable(tree.root);
  expect(project(tree).skeleton).toEqual([]);
});
