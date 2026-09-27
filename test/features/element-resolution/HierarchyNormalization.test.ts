import { describe, expect, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ViewHierarchyResult } from "../../../src/models";

const normalizer = () =>
  new ViewHierarchy(
    { deviceId: "ios-test", platform: "ios", name: "test" },
    undefined,
    new FakeCtrlProxy() as any,
    new FakeTimer(),
  );
const capture: ViewHierarchyResult = {
  screenWidth: 100,
  screenHeight: 100,
  updatedAt: 7,
  hierarchy: {
    bounds: [0, 0, 100, 100],
    node: [
      {
        class: "WKWebView",
        bounds: [0, 0, 100, 100],
        node: { text: "Visible", bounds: [0, 0, 20, 20] },
      },
      { text: "Offscreen", bounds: [0, 500, 20, 550] },
    ],
  },
};

describe("shared iOS capture normalization", () => {
  test("direct sync uses cleanup and the same visible projection as observe", () => {
    const reader = normalizer();
    const result = reader.projectActionableHierarchy(reader.normalizeIosHierarchy(capture));
    const nodes: string[] = [];
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(result)) {
      parser.traverseNode(root, (node) => {
        const props = parser.extractNodeProperties(node);
        if (props.text) {
          nodes.push(props.text);
        }
        expect(props.class).not.toBe("WKWebView");
      });
    }
    expect(nodes).toEqual(["Visible"]);
    expect(result.updatedAt).toBe(7);
  });
  test("secondary window projections cannot reintroduce offscreen nodes", () => {
    const reader = normalizer();
    const source = { ...capture, windows: [{ windowLayer: 2, hierarchy: capture.hierarchy }] };
    const result = reader.projectActionableHierarchy(reader.normalizeIosHierarchy(source));
    expect(JSON.stringify(result.windows)).not.toContain("Offscreen");
  });
});
