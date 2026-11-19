import { describe, expect, test } from "bun:test";
import { ShareSheet } from "../../../src/features/shareSheet/ShareSheet";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type {
  BootedDevice,
  Point,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
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

const parser = new DefaultElementParser();
const device: BootedDevice = { platform: "ios", deviceId: "test-ios", name: "test" };

function makeShareSheet(hierarchy: ViewHierarchyResult = ios26) {
  const taps: Array<{ point: Point; frameContext?: string }> = [];
  const timer = new FakeTimer();
  const reads: number[] = [];
  const tool = new ShareSheet(device, {
    platform: "ios",
    async read() {
      reads.push(timer.now());
      return hierarchy;
    },
    async tap(point, frameContext) {
      taps.push({ point, frameContext });
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

  test("taps the selected cell center with the captured frame context", async () => {
    const { tool, taps, timer } = makeShareSheet();
    expect(await tool.execute({ action: "select", label: "Playground" })).toEqual({
      success: true,
      action: "select",
      sheetKind: "ios-activity-view-controller",
      selected: { label: "Playground", kind: "app" },
    });
    expect(taps).toEqual([{ point: { x: 156, y: 663 }, frameContext: ios26.frameContext }]);
    expect(timer.getSleepHistory()).toEqual([]);
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
    expect(taps).toEqual([{ point: { x: 201, y: 437 }, frameContext: ios26.frameContext }]);
  });

  test("uses the exposed area when the sheet covers the dismiss region center", async () => {
    const expanded = structuredClone(ios26);
    nodeAttributes(findNode(expanded, "ShareSheet.RemoteContainerView")).bounds = [
      9, 300, 393, 864,
    ];
    const { tool, taps } = makeShareSheet(expanded);
    await tool.execute({ action: "dismiss" });
    expect(taps).toEqual([{ point: { x: 201, y: 150 }, frameContext: ios26.frameContext }]);
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
