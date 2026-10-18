import { describe, expect, test } from "bun:test";
import type { ElementParser } from "../../src/utils/interfaces/ElementParser";
import {
  capturedAppLayerPrototypeHierarchy,
  capturedTwoWindowHierarchy,
} from "../helpers/prototypeWindowCapture";

/**
 * Shared behavioural contract for {@link ElementParser} (#11868): DefaultElementParser and the
 * FakeElementParser (with no canned `next*` overrides) walk the same captured two-window
 * hierarchies and the same traversal shapes, so the fake cannot drift from the real parser.
 */
export function runElementParserContract(name: string, make: () => ElementParser): void {
  describe(`${name} ElementParser contract`, () => {
    test("window root groups are ordered by layer in both directions", () => {
      const parser = make();
      const hierarchy = capturedTwoWindowHierarchy();
      const top = parser.extractWindowRootGroups(hierarchy, "topmost-first");
      const bottom = parser.extractWindowRootGroups(hierarchy, "bottommost-first");

      expect(top.length).toBeGreaterThan(1);
      expect(bottom).toEqual([...top].reverse());
      expect(parser.extractWindowRootGroups(hierarchy)).toEqual(top);
    });

    test("window root nodes are the groups flattened in the same order", () => {
      const parser = make();
      const hierarchy = capturedTwoWindowHierarchy();

      expect(parser.extractWindowRootNodes(hierarchy, "bottommost-first")).toEqual(
        parser.extractWindowRootGroups(hierarchy, "bottommost-first").flat(),
      );
    });

    test("root nodes and window groups are empty for a hierarchy without them", () => {
      const parser = make();

      expect(parser.extractRootNodes({} as never)).toEqual([]);
      expect(parser.extractWindowRootGroups({} as never)).toEqual([]);
    });

    test("flattened elements are indexed in order with parsed bounds", () => {
      const parser = make();
      const flat = parser.flattenViewHierarchy(capturedAppLayerPrototypeHierarchy());

      expect(flat.length).toBeGreaterThan(0);
      expect(flat.map((entry) => entry.index)).toEqual(flat.map((_, i) => i));
      for (const { element, depth } of flat) {
        expect(depth).toBeGreaterThanOrEqual(0);
        expect(element.bounds.right).toBeGreaterThanOrEqual(element.bounds.left);
        expect("node" in element).toBe(false);
      }
    });

    test("flattening with windows included never yields fewer elements", () => {
      const parser = make();
      const hierarchy = capturedTwoWindowHierarchy();
      const plain = parser.flattenViewHierarchy(hierarchy);
      const windowed = parser.flattenViewHierarchy(hierarchy, { includeWindows: true });

      expect(windowed.length).toBeGreaterThanOrEqual(plain.length);
    });

    test("node properties drop bounds and children", () => {
      const parser = make();
      const properties = parser.extractNodeProperties({
        text: "ok",
        bounds: { left: 0, top: 0, right: 1, bottom: 1 },
        node: [{ text: "child" }],
      } as never);

      expect(properties).toEqual({ text: "ok" });
    });

    test("nodes without valid bounds do not parse into elements", () => {
      const parser = make();

      expect(parser.parseNodeBounds({ text: "x" } as never)).toBeNull();
      expect(parser.parseNodeBounds(null as never)).toBeNull();
      expect(parser.parseBounds({ left: 1, top: 2, right: 3, bottom: 4 })).toEqual({
        left: 1,
        top: 2,
        right: 3,
        bottom: 4,
      });
      expect(parser.parseBounds("garbage")).toBeNull();
    });

    test("traversal is depth-first with depths over node and children arrays", () => {
      const parser = make();
      const visited: Array<[string, number]> = [];
      const tree = {
        id: "a",
        node: [{ id: "b", children: [{ id: "c" }] }, { id: "d" }],
      };
      parser.traverseNode(tree, (node, depth) => visited.push([node.id, depth]));

      expect(visited).toEqual([
        ["a", 0],
        ["b", 1],
        ["c", 2],
        ["d", 1],
      ]);
    });

    test("traversal visits a single object child but ignores scalar children", () => {
      const parser = make();
      const visited: string[] = [];
      parser.traverseNode({ id: "a", node: { id: "b", node: "scalar" } }, (node) => {
        visited.push(typeof node === "object" ? node.id : String(node));
      });

      expect(visited).toEqual(["a", "b"]);
    });

    test("traversal of a missing node is a no-op", () => {
      const parser = make();
      let calls = 0;
      parser.traverseNode(undefined, () => calls++);

      expect(calls).toBe(0);
    });
  });
}
