import { mergeIosSdkBridgeInto } from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import { describe, expect, test } from "bun:test";
import {
  iosSdkBridgeTarget,
  mergeIosSdkObservation,
} from "../../../../src/features/observe/ios/iosSdkObservationMerge";
import type {
  IosSdkObservation,
  IosSdkObservationNode,
} from "../../../../src/features/observe/ios/sdkObservationBridge";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function node(partial: Partial<IosSdkObservationNode> & { id: string }): IosSdkObservationNode {
  return {
    role: "button",
    bounds: bounds(0, 0, 10, 10),
    enabled: true,
    visible: true,
    focused: false,
    children: [],
    ...partial,
  };
}

function xctestHierarchy(): ViewHierarchyResult {
  return {
    packageName: "com.example.app",
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: bounds(0, 0, 402, 874) },
        node: [
          { $: { class: "UIButton", text: "Submit", bounds: bounds(10, 10, 90, 40) } },
          { $: { class: "UILabel", text: "Header", bounds: bounds(0, 50, 402, 80) } },
          { $: { class: "UIKeyboardKey", text: "q", bounds: bounds(4, 590, 43, 644) } },
        ],
      },
    },
  };
}

function observation(root: IosSdkObservationNode): IosSdkObservation {
  return {
    captureIdentity: 41,
    orientation: "portrait",
    coordinateSpace: "screen",
    bounds: bounds(0, 0, 402, 874),
    root,
    capabilities: [],
  };
}

describe("mergeIosSdkObservation (#5159)", () => {
  test("attaches visible bridge nodes under the app node with mapped attributes", () => {
    const hierarchy = xctestHierarchy();
    const appNode = hierarchy.hierarchy.node;
    const summary = mergeIosSdkObservation(
      hierarchy,
      observation(
        node({
          id: "root",
          role: "window",
          bounds: bounds(0, 0, 402, 874),
          children: [
            node({
              id: "save",
              label: "Save",
              value: "ready",
              focused: true,
              bounds: bounds(10, 100, 90, 140),
            }),
            node({ id: "hidden", visible: false }),
            node({ id: "off", enabled: false, bounds: bounds(10, 150, 90, 190) }),
          ],
        }),
      ),
    );

    expect(summary).toEqual({ attached: 3, deduplicated: 0 });
    // Merged in place, so an identity bound to the hierarchy object stays valid.
    expect(hierarchy.hierarchy.node).toBe(appNode);
    const bridgeRoot = appNode?.node?.at(-1);
    expect(bridgeRoot?.extras).toEqual({ "sdk.source": "sdkBridge" });
    const [save, off] = bridgeRoot?.node ?? [];
    expect(save?.$).toMatchObject({
      "resource-id": "save",
      "test-tag": "save",
      "content-desc": "Save",
      text: "ready",
      class: "button",
      clickable: "true",
      focused: "true",
      enabled: "true",
      "sdk-element-id": "save",
      "sdk-capture-identity": "41",
    });
    expect(off?.$?.clickable).toBeUndefined();
    expect(off?.$?.enabled).toBe("false");
  });

  test("removes XCTest leaves a bridge node covers and keeps system UI", () => {
    const hierarchy = xctestHierarchy();
    const summary = mergeIosSdkObservation(
      hierarchy,
      observation(node({ id: "submit", label: "Submit", bounds: bounds(10, 10, 90, 40) })),
    );
    expect(summary?.deduplicated).toBe(1);
    const xctestTexts = (hierarchy.hierarchy.node?.node ?? [])
      .map((child) => child.$?.text)
      .filter((text) => text !== undefined);
    expect(xctestTexts).toEqual(["Header", "q"]);
  });

  test("leaves the hierarchy untouched without an app node or a visible bridge root", () => {
    const empty: ViewHierarchyResult = { hierarchy: {} };
    expect(mergeIosSdkObservation(empty, observation(node({ id: "a" })))).toBeNull();
    const hierarchy = xctestHierarchy();
    const before = JSON.stringify(hierarchy);
    expect(
      mergeIosSdkObservation(hierarchy, observation(node({ id: "a", visible: false }))),
    ).toBeNull();
    expect(JSON.stringify(hierarchy)).toBe(before);
  });

  test("a merged element names its bridge target; an XCTest element names none", () => {
    expect(iosSdkBridgeTarget({ "sdk-element-id": "save", "sdk-capture-identity": "41" })).toEqual({
      elementId: "save",
      observationIdentity: 41,
    });
    expect(iosSdkBridgeTarget({ "resource-id": "save" })).toBeNull();
    expect(
      iosSdkBridgeTarget({ "sdk-element-id": "save", "sdk-capture-identity": "x" }),
    ).toBeNull();
  });
});

for (const bundleId of ["com.example.other", "com.example.app", undefined]) {
  test(`bridge merge checks snapshot app identity: ${bundleId}`, async () => {
    const hierarchy = xctestHierarchy();
    const before = structuredClone(hierarchy);
    const snapshot = { ...observation(node({ id: "bridge" })), bundleId };
    const result = await mergeIosSdkBridgeInto(hierarchy, {
      observe: async () => ({ kind: "observation", observation: snapshot }),
    });
    if (bundleId === "com.example.other") {
      expect(result).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
      expect(hierarchy).toEqual(before);
    } else {
      expect(result).toEqual({ backend: "sdk" });
      expect(hierarchy).not.toEqual(before);
    }
  });
}
