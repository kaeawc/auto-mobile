import { convertIosHierarchy } from "../../helpers/iosHierarchyConverter";
import { describe, expect, test } from "bun:test";
import {
  projectActionableHierarchy,
  resolveActionableHierarchyScreenSize,
} from "../../../src/features/observe/HierarchyNormalization";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import type { ViewHierarchyAndroidCtrlProxy } from "../../../src/features/observe/android/ViewHierarchyAndroidCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import duoInnerPlaygroundHierarchy from "../../fixtures/ios-duo/observe-inner-playground-hierarchy-17306.json";
import duoDemosRawHierarchy from "../../fixtures/ios-duo/issue8379-demos-raw-hierarchy.json";
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

// Captured on an unfolded iPhone Duo (iOS 27.1): the application root keeps the portrait frame
// 669x951 while the content is the 951x669 landscape inner panel (#17306).
describe("iPhone Duo inner-panel root bounds", () => {
  const project = (multiPanel: boolean) => {
    const reader = normalizer();
    return projectActionableHierarchy(
      "ios",
      reader.normalizeIosHierarchy(wireCapture(structuredClone(duoDemosRawHierarchy))),
      multiPanel,
    );
  };

  test("the application root is reported in the landscape space of the screen size", () => {
    for (const multiPanel of [false, true]) {
      expect(project(multiPanel).hierarchy.bounds).toEqual({
        left: 0,
        top: 0,
        right: 951,
        bottom: 669,
      });
    }
  });

  // Consumers of a projected capture (pinchOn's capture geometry) must keep the landscape size
  // rather than re-deriving it from the corrected root plus the runner's portrait metadata.
  test("the projected capture still resolves to the landscape screen size", () => {
    for (const multiPanel of [false, true]) {
      expect(resolveActionableHierarchyScreenSize(project(multiPanel))).toEqual({
        width: 951,
        height: 669,
      });
    }
  });

  // Observe projects once in the collector and again when identifying the capture.
  test("re-projecting a projected capture keeps the landscape screen size", () => {
    for (const multiPanel of [false, true]) {
      const twice = projectActionableHierarchy("ios", project(multiPanel), multiPanel);
      expect(resolveActionableHierarchyScreenSize(twice)).toEqual({ width: 951, height: 669 });
      expect(twice.hierarchy.bounds).toEqual({ left: 0, top: 0, right: 951, bottom: 669 });
    }
  });

  // The runner's wire form: the application is the single `node` and its bounds sit in `$`.
  test("the wire-form application node is corrected too, keeping the tuple shape", () => {
    const projected = projectActionableHierarchy(
      "ios",
      wireCapture(structuredClone(duoInnerPlaygroundHierarchy)),
      true,
    );
    const root = projected.hierarchy.node;
    expect(root && !Array.isArray(root) ? root.$?.["bounds"] : undefined).toEqual([0, 0, 951, 669]);
  });
});
