import { describe, expect, test } from "bun:test";
import {
  getHierarchySnapshot,
  identifyObservedHierarchy,
} from "../../../../src/features/observe/HierarchyCapture";
import {
  createIosSdkBridgeReader,
  type IosSdkBridgeClient,
  mergeIosSdkBridgeInto,
} from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import type { IosSdkObservation } from "../../../../src/features/observe/ios/sdkObservationBridge";
import { hashHierarchyForSettle } from "../../../../src/features/observe/wait/WaitSettle";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { hierarchyFingerprint } from "../../../../src/utils/hierarchyFingerprint";
import { FakeTimer } from "../../../fakes/FakeTimer";

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function xctestHierarchy(): ViewHierarchyResult {
  return {
    packageName: "com.example.app",
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: bounds(0, 0, 402, 874) },
        node: [{ $: { class: "UILabel", text: "Header", bounds: bounds(0, 50, 402, 80) } }],
      },
    },
  };
}

function observation(captureIdentity: number): IosSdkObservation {
  return {
    captureIdentity,
    orientation: "portrait",
    coordinateSpace: "screen",
    bounds: bounds(0, 0, 402, 874),
    root: {
      id: "save",
      role: "button",
      label: "Save",
      bounds: bounds(10, 100, 90, 140),
      enabled: true,
      visible: true,
      focused: false,
      children: [],
    },
    capabilities: [],
  };
}

function readerFor(captureIdentity: number) {
  const client: IosSdkBridgeClient = {
    getObservationBridgeStateForIos: async () => ({
      status: "available",
      schemaVersion: 1,
      supportedActions: ["tap"],
    }),
    requestSdkObservationForIos: async () => ({
      success: true,
      available: true,
      observation: observation(captureIdentity),
      totalTimeMs: 1,
    }),
    requestSdkActionForIos: async () => {
      throw new Error("not used");
    },
  };
  return createIosSdkBridgeReader({ client: () => client, enabled: () => true });
}

const ids = { next: () => "capture-1" };

describe("SDK bridge merge keeps selectors and change detection right (#5159)", () => {
  test("a snapshot bound before the merge indexes the merged bridge nodes", async () => {
    const hierarchy = xctestHierarchy();
    identifyObservedHierarchy("ios", hierarchy, "fresh", new FakeTimer(), ids);
    const indexed = () =>
      JSON.stringify(getHierarchySnapshot(hierarchy)?.nodes ?? []).includes('"save"');
    expect(indexed()).toBe(false);

    await mergeIosSdkBridgeInto(hierarchy, readerFor(41));

    expect(indexed()).toBe(true);
    expect(getHierarchySnapshot(hierarchy)?.captureId).toBe("capture-1");
  });

  test("an unchanged screen hashes the same across bridge captures", async () => {
    const first = xctestHierarchy();
    const second = xctestHierarchy();
    await mergeIosSdkBridgeInto(first, readerFor(41));
    await mergeIosSdkBridgeInto(second, readerFor(42));

    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
    expect(hierarchyFingerprint(first)).toBe(hierarchyFingerprint(second));
    expect(hashHierarchyForSettle(first)).toBe(hashHierarchyForSettle(second));
  });
});
