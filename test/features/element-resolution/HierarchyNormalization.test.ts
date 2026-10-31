import { convertIosHierarchy } from "../../helpers/iosHierarchyConverter";
import { describe, expect, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import type { ViewHierarchyAndroidCtrlProxy } from "../../../src/features/observe/android/ViewHierarchyAndroidCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { wireCapture } from "../../helpers/wireCapture";

const notUsedOnIos = (): never => {
  throw new Error("iOS hierarchy normalization never reads the Android CtrlProxy");
};
const unusedAndroidProxy: ViewHierarchyAndroidCtrlProxy = {
  getAccessibilityHierarchy: notUsedOnIos,
  setRecompositionTrackingEnabled: notUsedOnIos,
  getSdkScreenIdentity: notUsedOnIos,
};

const normalizer = () =>
  new ViewHierarchy(
    { deviceId: "ios-test", platform: "ios", name: "test" },
    undefined,
    unusedAndroidProxy,
    { timer: new FakeTimer() },
  );
const capture = {
  packageName: "com.example",
  screenWidth: 100,
  screenHeight: 100,
  updatedAt: 7,
  hierarchy: {
    bounds: [0, 0, 100, 100] satisfies [number, number, number, number],
    node: [
      {
        class: "WKWebView",
        bounds: [0, 0, 100, 100] satisfies [number, number, number, number],
        node: {
          text: "Visible",
          bounds: [0, 0, 20, 20] satisfies [number, number, number, number],
        },
      },
      { text: "Offscreen", bounds: [0, 500, 20, 550] satisfies [number, number, number, number] },
    ],
  },
};

describe("shared iOS capture normalization", () => {
  test("direct sync uses cleanup and the same visible projection as observe", () => {
    const reader = normalizer();
    const result = reader.projectActionableHierarchy(
      reader.normalizeIosHierarchy(convertIosHierarchy(capture)),
    );
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
    const source = {
      ...capture,
      windows: wireCapture({
        hierarchy: {},
        windows: [{ windowLayer: 2, hierarchy: capture.hierarchy }],
      }).windows,
    };
    const result = reader.projectActionableHierarchy(
      reader.normalizeIosHierarchy(convertIosHierarchy(source)),
    );
    expect(JSON.stringify(result.windows)).not.toContain("Offscreen");
  });
});
