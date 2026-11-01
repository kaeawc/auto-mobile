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
import { ResolverElementSelector } from "../../../../src/features/utility/ResolverElementSelector";
import { isEditableElementProperties } from "../../../../src/features/utility/elementProperties";
import { sdkTargetField } from "../../../../src/features/action/SendKeys";
import capturedInputNodes from "../../../fixtures/ios-contract/observation-run4-input-nodes.json";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { identifyObservedHierarchy } from "../../../../src/features/observe/HierarchyCapture";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
  test("run4's bridge field gains input in observe and the bound sendKeys selector", async () => {
    const [capturedEmail, capturedSearch] = capturedInputNodes;
    expect(capturedEmail.affordances).toEqual(["tap"]);
    expect(capturedSearch.affordances).toEqual(["tap", "input"]);
    const [left, top, right, bottom] = capturedEmail.bounds;
    const hierarchy = xctestHierarchy();
    const timer = new FakeTimer();
    identifyObservedHierarchy("ios", hierarchy, "fresh", {
      timer,
      ids: { next: () => "contract-capture" },
    });
    await mergeIosSdkBridgeInto(hierarchy, {
      observe: async () => ({
        kind: "observation",
        observation: observation(
          node({
            id: capturedEmail.elementId,
            label: capturedEmail.label,
            bounds: bounds(left, top, right, bottom),
            // Public rows omit role/focus; these come from the actual contract provider's
            // SdkContractObservationScenario.snapshot, not inferred from the captured label.
            role: "textField",
            focused: true,
            value: "",
          }),
        ),
      }),
    });
    const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");
    const row = projectSkeleton(elements!).skeleton.find(
      (entry) => entry.elementId === capturedEmail.elementId,
    );
    expect(row).toEqual({
      ...capturedEmail,
      bounds: [left, top, right, bottom],
      affordances: ["tap", "input"],
    });
    const selected = new ResolverElementSelector().select(
      hierarchy,
      { elementId: row!.elementId },
      { intentAction: "focus-input", selectionIntent: "focus-input" },
    );
    expect(selected.element).not.toBeNull();
    expect(selected.captureId).toBe("contract-capture");
    expect(sdkTargetField({ platform: "ios" }, selected.element ?? undefined)).toEqual({
      sdkTarget: { elementId: capturedEmail.elementId, observationIdentity: 41 },
    });
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("the contract host's textField role remains an editable sendKeys focus target", () => {
    const hierarchy = xctestHierarchy();
    // The provider's model contract from SdkContractObservationScenario.snapshot; no device I/O.
    mergeIosSdkObservation(
      hierarchy,
      observation(
        node({
          id: "contract-email",
          role: "textField",
          label: "Contract email",
          value: "",
          focused: true,
          bounds: bounds(24, 280, 366, 324),
        }),
      ),
    );
    const selected = new ResolverElementSelector().select(
      hierarchy,
      { elementId: "contract-email" },
      { intentAction: "focus-input", selectionIntent: "focus-input" },
    );
    expect(selected.element).not.toBeNull();
    expect(isEditableElementProperties(selected.element!)).toBe(true);
    expect(selected.element?.focused).toBe("true");
    expect(sdkTargetField({ platform: "ios" }, selected.element ?? undefined)).toEqual({
      sdkTarget: { elementId: "contract-email", observationIdentity: 41 },
    });
  });

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

  test.each(["window", "view"])(
    "rejects a %s-space observation without touching the screen-space hierarchy (#15819)",
    (coordinateSpace) => {
      const hierarchy = xctestHierarchy();
      const before = JSON.stringify(hierarchy);
      const local = { ...observation(node({ id: "save", label: "Save" })), coordinateSpace };
      expect(mergeIosSdkObservation(hierarchy, local)).toBeNull();
      expect(JSON.stringify(hierarchy)).toBe(before);
    },
  );

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
