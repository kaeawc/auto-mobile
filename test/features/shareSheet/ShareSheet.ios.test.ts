import { describe, expect, test } from "bun:test";
import { ShareSheet } from "../../../src/features/shareSheet/ShareSheet";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type {
  BootedDevice,
  Point,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import type {
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import { runWithToolSelectionContext } from "../../../src/features/toolSelection/toolSelectionContext";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { getStructuredField, type StructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

const capture: StructuredToolResponse<{ viewHierarchy: ViewHierarchyResult }> = await Bun.file(
  new URL("../../fixtures/shareSheet/ios26-activityviewcontroller-observe.json", import.meta.url),
).json();
const viewHierarchy = getStructuredField(capture, "viewHierarchy");
if (!viewHierarchy) {
  throw new Error("Missing captured iOS view hierarchy");
}
const ios26: ViewHierarchyResult = viewHierarchy;
const ios27Capture: StructuredToolResponse<{ viewHierarchy: ViewHierarchyResult }> = await Bun.file(
  new URL("../../fixtures/shareSheet/ios27-activityviewcontroller-observe.json", import.meta.url),
).json();
const ios27Hierarchy = getStructuredField(ios27Capture, "viewHierarchy");
if (!ios27Hierarchy) {
  throw new Error("Missing captured iOS 27 view hierarchy");
}
const ios27: ViewHierarchyResult = ios27Hierarchy;

const parser = new DefaultElementParser();
const device: BootedDevice = { platform: "ios", deviceId: "test-ios", name: "test" };

function makeShareSheet(hierarchy: ViewHierarchyResult = ios26) {
  const taps: Point[] = [];
  const timer = new FakeTimer();
  const reads: number[] = [];
  const tool = new ShareSheet(device, {
    platform: "ios",
    async read() {
      reads.push(timer.now());
      return hierarchy;
    },
    async tap(point) {
      taps.push(point);
    },
  });
  return { tool, reads, taps, timer };
}

function findNode(hierarchy: ViewHierarchyResult, id: string, label?: string): ViewHierarchyNode {
  let found: ViewHierarchyNode | undefined;
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (
        !found &&
        attributes["resource-id"] === id &&
        (label === undefined || attributes.text === label)
      ) {
        found = node;
      }
    });
  }
  if (!found) {
    throw new Error(`Missing captured node ${id}`);
  }
  return found;
}

describe("iOS share sheet", () => {
  test("lists the exact target labels and kinds in the capture", async () => {
    const { tool, taps } = makeShareSheet();
    expect(await tool.execute({ action: "list" })).toEqual({
      success: true,
      action: "list",
      sheetKind: "ios-activity-view-controller",
      targets: [
        { label: "Reminders", kind: "app" },
        { label: "Playground", kind: "app" },
        { label: "More", kind: "action" },
        { label: "Copy", kind: "action" },
        { label: "Save to Files", kind: "action" },
      ],
    });
    expect(taps).toEqual([]);
  });

  test("taps the selected cell center without a frame context", async () => {
    const { tool, taps, timer } = makeShareSheet();
    expect(await tool.execute({ action: "select", label: "Playground" })).toEqual({
      success: true,
      action: "select",
      sheetKind: "ios-activity-view-controller",
      selected: { label: "Playground", kind: "app" },
    });
    expect(taps).toEqual([{ x: 156, y: 663 }]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("lists iOS 27 app cells whose title is the cell's own text", async () => {
    // iOS 27.2 app cells have no cellTitleLabel children; the action cells still do.
    const { tool, taps } = makeShareSheet(ios27);
    expect(await tool.execute({ action: "list" })).toEqual({
      success: true,
      action: "list",
      sheetKind: "ios-activity-view-controller",
      targets: [
        { label: "Reminders", kind: "app" },
        { label: "Playground", kind: "app" },
        { label: "More", kind: "action" },
        { label: "Copy", kind: "action" },
        { label: "Save to Files", kind: "action" },
      ],
    });
    expect(taps).toEqual([]);
  });

  test("selects an iOS 27 app cell by its own text", async () => {
    const { tool, taps } = makeShareSheet(ios27);
    expect(await tool.execute({ action: "select", label: "Playground" })).toMatchObject({
      selected: { label: "Playground", kind: "app" },
    });
    expect(taps).toEqual([{ x: 157, y: 668 }]);
  });

  test("refuses duplicate labels without tapping", async () => {
    const duplicate = structuredClone(ios26);
    nodeAttributes(findNode(duplicate, "cellTitleLabel", "Playground")).text = "Reminders";
    const { tool, taps } = makeShareSheet(duplicate);
    await expect(tool.execute({ action: "select", label: "Reminders" })).rejects.toThrow(
      /Ambiguous share target "Reminders".*Use a unique label/,
    );
    expect(taps).toEqual([]);
  });

  test("refuses appId before reading the hierarchy", async () => {
    const { tool, reads, taps } = makeShareSheet();
    await expect(tool.execute({ action: "select", appId: "com.apple.reminders" })).rejects.toThrow(
      /Omit appId and use shareSheet list/,
    );
    expect(reads).toEqual([]);
    expect(taps).toEqual([]);
  });

  test("refuses to select the shared text preview", async () => {
    const { tool, taps } = makeShareSheet();
    await expect(
      tool.execute({ action: "select", label: "AutoMobile share sheet demo" }),
    ).rejects.toThrow(/No share target matches.*Run shareSheet list/);
    expect(taps).toEqual([]);
  });

  test("dismisses through the popup region outside the sheet", async () => {
    const { tool, taps } = makeShareSheet();
    expect(await tool.execute({ action: "dismiss" })).toEqual({
      success: true,
      action: "dismiss",
      sheetKind: "ios-activity-view-controller",
    });
    expect(taps).toEqual([{ x: 201, y: 437 }]);
  });

  test("uses the exposed area when the sheet covers the dismiss region center", async () => {
    const expanded = structuredClone(ios26);
    nodeAttributes(findNode(expanded, "ShareSheet.RemoteContainerView")).bounds = [
      9, 300, 393, 864,
    ];
    const { tool, taps } = makeShareSheet(expanded);
    await tool.execute({ action: "dismiss" });
    expect(taps).toEqual([{ x: 201, y: 150 }]);
  });

  test("does not tap a one-point exposed strip that rounds onto the sheet edge", async () => {
    const nearlyCovered = structuredClone(ios26);
    // The popup region is [0,0,402,874]; only the strip [873,874) stays exposed below the sheet.
    nodeAttributes(findNode(nearlyCovered, "ShareSheet.RemoteContainerView")).bounds = [
      0, 0, 402, 873,
    ];
    const { tool, taps } = makeShareSheet(nearlyCovered);
    await expect(tool.execute({ action: "dismiss" })).rejects.toThrow(
      /no tappable "dismiss popup" region/,
    );
    expect(taps).toEqual([]);
  });

  test("lists a sessionless device read through the connect-only observer capture", async () => {
    const requests: HierarchyCaptureRequest[] = [];
    const tool = new ShareSheet(device, undefined, {
      captureFactory: () => ({
        async capture(request) {
          requests.push(request);
          const snapshot: HierarchySnapshot = {
            captureId: "observer-read",
            platform: "ios",
            requestedFreshness: request.freshness,
            receivedAt: 0,
            hierarchy: ios26,
            nodes: [],
          };
          return snapshot;
        },
      }),
    });
    const result = await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      tool.execute({ action: "list" }),
    );
    expect(result.targets?.map(({ label }) => label)).toContain("Playground");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ freshness: "fresh", observerMode: true });
  });

  test("reports a missing popup dismiss region without tapping", async () => {
    const undismissable = structuredClone(ios26);
    delete nodeAttributes(findNode(undismissable, "PopoverDismissRegion"))["resource-id"];
    const { tool, taps } = makeShareSheet(undismissable);
    await expect(tool.execute({ action: "dismiss" })).rejects.toThrow(
      /no tappable "dismiss popup" region.*Observe the screen/,
    );
    expect(taps).toEqual([]);
  });

  test("reports that the sheet is absent even if the popup dismiss region exists", async () => {
    const absent = structuredClone(ios26);
    delete nodeAttributes(findNode(absent, "ShareSheet.RemoteContainerView"))["resource-id"];
    const { tool, taps } = makeShareSheet(absent);
    await expect(tool.execute({ action: "dismiss" })).rejects.toThrow(
      /iOS share sheet is not showing.*Open it from the app under test/,
    );
    expect(taps).toEqual([]);
  });
});
