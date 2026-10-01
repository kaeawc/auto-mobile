import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { RealHierarchyPlatformValidator } from "../../../src/features/observe/HierarchyPlatformValidator";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import {
  encodeAndroidFlat,
  encodeCleanedRoot,
  encodeIosDollar,
  logicalNodeArb,
  withWindows,
  type LogicalNode,
} from "../../fixtures/hierarchyArbitraries";

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 250 } as const;
const parser = new DefaultElementParser();

function read(hierarchy: ViewHierarchyResult) {
  const nodes: Array<{ properties: unknown; bounds: unknown }> = [];
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      nodes.push({
        properties: parser.extractNodeProperties(node),
        bounds: parser.parseNodeBounds(node)?.bounds ?? null,
      });
    });
  }
  return nodes;
}

function count(node: LogicalNode): number {
  return 1 + node.children.reduce((total, child) => total + count(child), 0);
}

describe("DefaultElementParser (property-based)", () => {
  // Properties contain only attributes for every supported wire shape.
  test("all supported wire encodings preserve properties, bounds, and traversal order", () => {
    fc.assert(
      fc.property(logicalNodeArb, (tree) => {
        const android: ViewHierarchyResult = { hierarchy: { node: encodeAndroidFlat(tree) } };
        const ios: ViewHierarchyResult = { hierarchy: { node: encodeIosDollar(tree) } };
        const cleaned = encodeCleanedRoot(tree);
        const expected = read(android);
        expect(read(ios)).toEqual(expected);
        expect(read(cleaned)).toEqual(expected);
        expect(expected).toHaveLength(count(tree));
      }),
      RUN_OPTIONS,
    );
  });

  test("single and array child slots remain equivalent", () => {
    fc.assert(
      fc.property(logicalNodeArb, (tree) => {
        const child = tree.children[0] ?? { attrs: {}, children: [] };
        const encodedChild = encodeAndroidFlat(child);
        const singleChildRoot: ViewHierarchyNode = {
          class: "root",
          node: encodedChild,
        } as ViewHierarchyNode;
        const arrayChildRoot: ViewHierarchyNode = { class: "root", node: [encodedChild] };
        const roots = (node: ViewHierarchyNode): ViewHierarchyResult => ({ hierarchy: { node } });
        expect(read(roots(singleChildRoot))).toEqual(read(roots(arrayChildRoot)));
      }),
      RUN_OPTIONS,
    );
  });

  test("omitted optional attributes remain equivalent across flat and $ shapes", () => {
    const roots = (node: ViewHierarchyNode): ViewHierarchyResult => ({ hierarchy: { node } });
    const bounds = { left: 0, top: 0, right: 1, bottom: 1 };
    expect(read(roots({ bounds }))).toEqual(read(roots({ $: {}, bounds })));
  });

  test("window root groups preserve the same parsed tree", () => {
    fc.assert(
      fc.property(logicalNodeArb, (tree) => {
        const root = encodeAndroidFlat(tree);
        const hierarchy: ViewHierarchyResult = { hierarchy: { node: root } };
        const windows = withWindows({ hierarchy: {} }, [root]);
        const groups = parser.extractWindowRootGroups(windows);
        expect(groups).toHaveLength(1);
        expect(
          groups.flatMap((group) => group.flatMap((item) => read({ hierarchy: { node: item } }))),
        ).toEqual(read(hierarchy));
      }),
      RUN_OPTIONS,
    );
  });

  test("flat Android root class is recognized by platform validation", () => {
    fc.assert(
      fc.property(logicalNodeArb, (tree) => {
        const root = { ...encodeAndroidFlat(tree), class: "android.widget.FrameLayout" };
        const result = new RealHierarchyPlatformValidator().validate("ios", {
          hierarchy: { node: root },
        });
        expect(result.valid).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });
});
