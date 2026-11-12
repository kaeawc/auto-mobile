import { expect, test } from "bun:test";
import capture from "../../fixtures/visionos-xcuitest/hierarchy-ornament-window.json";
import {
  isVisionosHierarchy,
  normalizeVisionosHierarchy,
} from "../../../src/features/visionos/VisionosHierarchy";
import { convertToViewHierarchyResult } from "../../../src/features/observe/ios/IosHierarchyConverter";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import {
  projectSkeleton,
  projectSkeletonElement,
} from "../../../src/features/observe/output/SkeletonProjection";
import { nodeAttributes, type ViewHierarchyNode } from "../../../src/models/ViewHierarchyResult";
import {
  elementSchema,
  skeletonElementSchema,
  viewHierarchyNodeSchema,
} from "../../../src/server/toolOutputSchemas/elements";

function fixture() {
  const tree = structuredClone(capture.data);
  if (!isVisionosHierarchy(tree)) {
    throw new Error("Invalid captured visionOS hierarchy");
  }
  return tree;
}

function flat(node: ViewHierarchyNode | undefined): ViewHierarchyNode[] {
  return node ? [node, ...(node.node ?? []).flatMap(flat)] : [];
}

function projection(tree = fixture()) {
  const hierarchy = normalizeVisionosHierarchy(tree);
  const elements = new ObserveElementsBuilder().build(hierarchy, "ios")!;
  return {
    hierarchy,
    elements,
    ...projectSkeleton(
      elements,
      { width: hierarchy.screenWidth!, height: hierarchy.screenHeight! },
      undefined,
      { ios: true, iosHierarchy: hierarchy },
    ),
  };
}

test("captured scroll and system extents do not define the visionOS window size", () => {
  const tree = fixture();
  const original = structuredClone(tree);
  expect(tree.screenWidth).toBe(1680);
  expect(tree.screenHeight).toBe(2036);
  const { hierarchy, skeleton, context, elements } = projection(tree);
  expect(hierarchy).toMatchObject({ screenWidth: 1280, screenHeight: 720 });
  expect(skeleton.find((row) => row.label === "Add item")).toMatchObject({
    space: "ornament",
    bounds: [16, 16, 127, 60],
    affordances: ["tap"],
  });
  expect(context.find((row) => row.label === "Dogfood Items")).not.toHaveProperty("space");
  expect(skeleton.find((row) => row.label === "Item 1")).not.toHaveProperty("space");
  const ornament = elements.clickable.find((node) => node.text === "Add item")!;
  expect(ornament.space).toBe("ornament");
  expect(projectSkeletonElement(ornament)?.space).toBe("ornament");
  expect(tree).toEqual(original);
  for (const node of flat(hierarchy.hierarchy?.node)) {
    const attrs = nodeAttributes(node);
    if (attrs.space !== undefined) {
      expect(attrs.space).toBe("ornament");
    }
  }
});

test.each([1328, 2036])("reported height %i is ignored even after a sheet", (screenHeight) => {
  const tree = fixture();
  tree.screenHeight = screenHeight;
  expect(normalizeVisionosHierarchy(tree)).toMatchObject({ screenWidth: 1280, screenHeight: 720 });
});

test.each(["nonzero origin", "window sized", "member outside", "duplicate in window"])(
  "rejects an ornament candidate with %s using the captured nodes",
  (scenario) => {
    const tree = fixture();
    const nodes = tree.hierarchy.node!;
    const scene = nodes.find((node) => node.className === "4" && node.bounds.right === 143)!;
    const button = nodes.find((node) => node.text === "Add item")!;
    if (scenario === "nonzero origin") {
      scene.bounds.left = 1;
    }
    if (scenario === "window sized") {
      scene.bounds.right = 1280;
    }
    if (scenario === "member outside") {
      button.bounds.right = 144;
    }
    if (scenario === "duplicate in window") {
      nodes.unshift({
        ...structuredClone(button),
        bounds: { ...button.bounds, top: 600, bottom: 644 },
      });
    }
    const result = projection(tree);
    expect([...result.skeleton, ...result.context].filter((row) => row.space)).toEqual([]);
  },
);

test("nested scene captures retain ornament space after conversion", () => {
  const tree = fixture();
  const nodes = tree.hierarchy.node!;
  const start = nodes.findIndex((node) => node.className === "4" && node.bounds.right === 143);
  const end = nodes.findIndex((node, index) => index > start && node.className === "4");
  const members = nodes.splice(start + 1, end - start - 1);
  // Reparent captured nodes only; no invented hierarchy nodes.
  Object.assign(nodes[start], { node: members });
  expect(projection(tree).skeleton.find((row) => row.label === "Add item")?.space).toBe("ornament");
});

test.each(["0", "1"])("toggle snapshot value %s survives full observe elements", (value) => {
  const tree = fixture();
  const button = tree.hierarchy.node!.find((node) => node.text === "Settings")!;
  Object.assign(button, { value, className: "40" });
  const { elements } = projection(tree);
  expect(
    elements.text.find((node) => node.text === "Settings" && node.value === value)?.value,
  ).toBe(value);
  expect(
    flat(normalizeVisionosHierarchy(tree).hierarchy?.node)
      .map(nodeAttributes)
      .some((node) => node.text === "Settings" && node.value === value),
  ).toBe(true);
});

test("the shared iOS converter does not infer visionOS ornaments or replace screen dimensions", () => {
  const result = convertToViewHierarchyResult(fixture());
  expect(result).toMatchObject({ screenWidth: 1680, screenHeight: 2036 });
  expect(flat(result.hierarchy?.node).some((node) => nodeAttributes(node).space)).toBe(false);
});

test("output schemas retain and constrain ornament space", () => {
  const { elements, skeleton } = projection();
  const element = elements.clickable.find((node) => node.text === "Add item")!;
  const row = skeleton.find((node) => node.label === "Add item")!;
  expect(elementSchema.parse(element).space).toBe("ornament");
  expect(skeletonElementSchema.parse(row).space).toBe("ornament");
  expect(viewHierarchyNodeSchema.safeParse({ ...element, space: "screen" }).success).toBe(false);
  expect(skeletonElementSchema.safeParse({ ...row, space: "screen" }).success).toBe(false);
});

test("nonpositive root window dimensions fail closed", () => {
  const tree = fixture();
  tree.hierarchy.bounds.right = tree.hierarchy.bounds.left;
  expect(() => normalizeVisionosHierarchy(tree)).toThrow("Invalid visionOS window bounds");
});
