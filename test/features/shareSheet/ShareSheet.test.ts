import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractAndroidShareSheet } from "../../../src/features/shareSheet/androidShareSheet";
import type {
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import { ShareSheet } from "../../../src/features/shareSheet/ShareSheet";
import { runWithToolSelectionContext } from "../../../src/features/toolSelection/toolSelectionContext";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import {
  ActionableError,
  type BootedDevice,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../../src/models";
import {
  assertRequestedPlatformSupported,
  assertToolSupportsDevicePlatform,
} from "../../../src/server/applePlatformToolSupport";
import { getStructuredField, type StructuredToolResponse } from "../../../src/utils/toolUtils";
import { shareSheetTool } from "../../../src/server/shareSheetTool";
import { FakeTimer } from "../../fakes/FakeTimer";

async function loadFixture(filename: string): Promise<ViewHierarchyResult> {
  const capture: StructuredToolResponse<{ viewHierarchy: ViewHierarchyResult }> = await Bun.file(
    path.join(import.meta.dir, "../../fixtures/shareSheet", filename),
  ).json();
  const hierarchy = getStructuredField(capture, "viewHierarchy");
  if (!hierarchy) {
    throw new Error(`Missing captured view hierarchy in ${filename}`);
  }
  return hierarchy;
}

const android11 = await loadFixture("android11-chooser-observe.json");
const android14 = await loadFixture("android14-intentresolver-observe.json");
const parser = new DefaultElementParser();
const device: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "test" };
const SWIPE_UP = { args: ["swipe", "540", "2148", "540", "1644", "350"], displayId: 0 };

/** Pages model a list scrolled one page further per upward swipe and back per downward swipe. */
function makeShareSheet(pages: ViewHierarchyResult[], targetDevice = device) {
  const inputs: Array<{ args: string[]; displayId?: number }> = [];
  const timer = new FakeTimer();
  let position = 0;
  const tool = new ShareSheet(targetDevice, {
    platform: "android",
    async read(minTimestamp) {
      const capture = pages[position];
      return minTimestamp === undefined
        ? capture
        : { ...capture, updatedAt: (pages[0].updatedAt ?? 0) + timer.now() };
    },
    async input(args, displayId) {
      inputs.push({ args, displayId });
      if (args[0] === "swipe") {
        const up = Number(args[2]) > Number(args[4]);
        position = Math.max(0, Math.min(pages.length - 1, position + (up ? 1 : -1)));
      }
      timer.advanceTime(350);
      return { stderr: "" };
    },
  });
  return { tool, inputs, timer };
}

/** A copy of the capture with every row inside the chooser list moved up by `dy` pixels. */
function scrolled(capture: ViewHierarchyResult, dy: number): ViewHierarchyResult {
  const copy = { ...capture, hierarchy: structuredClone(capture.hierarchy) };
  const list = findNode(copy, (node) => node["resource-id"] === "android:id/resolver_list");
  parser.traverseNode(list, (node: ViewHierarchyNode) => {
    const bounds = node === list ? undefined : parser.parseNodeBounds(node)?.bounds;
    if (bounds) {
      node.bounds = { ...bounds, top: bounds.top - dy, bottom: bounds.bottom - dy };
    }
  });
  return copy;
}

function renamed(capture: ViewHierarchyResult, from: string, to: string): ViewHierarchyResult {
  const copy = { ...capture, hierarchy: structuredClone(capture.hierarchy) };
  findNode(copy, (node) => node.text === from).text = to;
  return copy;
}

function findNode(hierarchy: ViewHierarchyResult, predicate: (node: ViewHierarchyNode) => boolean) {
  let found: ViewHierarchyNode | undefined;
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      if (!found && predicate(node)) {
        found = node;
      }
    });
  }
  if (!found) {
    throw new Error("Expected node in capture");
  }
  return found;
}

describe("Android share sheet", () => {
  test("lists the exact visible Android 11 targets from the capture", async () => {
    const { tool, inputs } = makeShareSheet([android11]);
    expect(await tool.execute({ action: "list" })).toEqual({
      success: true,
      action: "list",
      sheetKind: "android-legacy",
      targets: [
        { label: "Copy", kind: "action" },
        { label: "AutoMobile Share Sink", kind: "app" },
        { label: "Bluetooth", kind: "app" },
        { label: "Gmail", kind: "app" },
        { label: "Messages", kind: "app" },
      ],
    });
    expect(inputs).toEqual([]);
  });

  test("lists the exact visible Android 14 targets from the capture", async () => {
    const { tool, inputs } = makeShareSheet([android14]);
    expect(await tool.execute({ action: "list" })).toEqual({
      success: true,
      action: "list",
      sheetKind: "android-intentresolver",
      targets: [
        { label: "Copy", kind: "action" },
        { label: "Nearby Share", kind: "app" },
        { label: "AutoMobile Share Sink", kind: "app" },
        { label: "Chrome", kind: "app" },
        { label: "Copy to clipboard", kind: "app" },
        { label: "Drive", kind: "app" },
      ],
    });
    expect(inputs).toEqual([]);
  });

  test("selects the captured clickable row by its secondary label", async () => {
    const { tool, inputs } = makeShareSheet([android14]);
    expect(await tool.execute({ action: "select", label: "AutoMobile Share Sink" })).toMatchObject({
      selected: { label: "AutoMobile Share Sink", kind: "app" },
    });
    expect(inputs).toEqual([SWIPE_UP, { args: ["tap", "324", "2185"], displayId: 0 }]);
  });

  test("selects a package only when it is present on the row", async () => {
    const icon = findNode(android14, (node) => node["resource-id"] === "android:id/item").node?.[0];
    if (!icon) {
      throw new Error("Expected captured row icon");
    }
    const resourceId = icon["resource-id"];
    icon["resource-id"] = "com.example.nearby:id/icon";
    try {
      const { tool, inputs } = makeShareSheet([android14]);
      expect(await tool.execute({ action: "select", appId: "com.example.nearby" })).toMatchObject({
        selected: { label: "Nearby Share", kind: "app", appId: "com.example.nearby" },
      });
      expect(inputs).toEqual([SWIPE_UP, { args: ["tap", "108", "2185"], displayId: 0 }]);
    } finally {
      icon["resource-id"] = resourceId;
    }
  });

  test("classifies a labelled legacy direct-share slot separately from apps", async () => {
    const icon = findNode(android11, (node) => node["view-id"] === "s2-0c82cec033a7cf13-1");
    const original = icon.node;
    const label = findNode(android11, (node) => node.text === "Messages");
    icon.node = [{ ...label, text: "Sample contact" }];
    try {
      const { tool } = makeShareSheet([android11]);
      const result = await tool.execute({ action: "list" });
      expect(result.targets).toContainEqual({ label: "Sample contact", kind: "direct" });
    } finally {
      icon.node = original;
    }
  });

  test("refuses a duplicated label and names its candidate bounds", async () => {
    const node = findNode(android11, (candidate) => candidate.text === "Messages");
    node.text = "Gmail";
    try {
      const { tool, inputs } = makeShareSheet([android11]);
      await expect(tool.execute({ action: "select", label: "Gmail" })).rejects.toThrow(
        /Ambiguous share target "Gmail".*Candidates: .*"left":540.*"left":810/,
      );
      expect(inputs).toEqual([]);
    } finally {
      node.text = "Messages";
    }
  });

  test("refuses a primary label shared by differently labelled targets", async () => {
    const { tool, inputs } = makeShareSheet([android14]);
    await expect(tool.execute({ action: "select", label: "Drive" })).rejects.toThrow(
      /Ambiguous share target "Drive".*Copy to clipboard.*Drive/,
    );
    expect(inputs).toEqual([]);
  });

  test("swipes and taps the row in the refreshed capture", async () => {
    const expanded = { ...android14, hierarchy: structuredClone(android14.hierarchy) };
    const newlyVisible = findNode(expanded, (node) => node.text === "Chrome");
    newlyVisible.text = "Gmail";
    const { tool, inputs, timer } = makeShareSheet([android14, expanded]);
    expect(await tool.execute({ action: "select", label: "Gmail" })).toMatchObject({
      selected: { label: "Gmail", kind: "app" },
    });
    // The second swipe finds the end of the list before tapping.
    expect(inputs).toEqual([SWIPE_UP, SWIPE_UP, { args: ["tap", "540", "2185"], displayId: 0 }]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("refuses a label repeated on a later page before tapping anything", async () => {
    const laterPage = renamed(android14, "Chrome", "AutoMobile Share Sink");
    const { tool, inputs } = makeShareSheet([android14, laterPage]);
    await expect(
      tool.execute({ action: "select", label: "AutoMobile Share Sink" }),
    ).rejects.toThrow(
      /Ambiguous share target "AutoMobile Share Sink".*Candidates: .*"left":216.*"left":432/,
    );
    expect(inputs).toEqual([SWIPE_UP]);
  });

  test("does not let the pinned Copy action vouch for a same-place row on the next page", async () => {
    // Page 2 shares only the pinned Copy action and the target's label with page 1, at the
    // same coordinates: a different app, so the label is ambiguous across pages.
    const laterPage = [
      ["Nearby Share", "Files"],
      ["Chrome", "Photos"],
      ["Copy to clipboard", "Keep"],
      ["Drive", "Maps"],
    ].reduce((page, [from, to]) => renamed(page, from, to), android14);
    const { tool, inputs } = makeShareSheet([android14, laterPage]);
    await expect(
      tool.execute({ action: "select", label: "AutoMobile Share Sink" }),
    ).rejects.toThrow(/Ambiguous share target "AutoMobile Share Sink"/);
    expect(inputs.some(({ args }) => args[0] === "tap")).toBe(false);
  });

  test("treats the same row carried up by the scroll as one target", async () => {
    const { tool, inputs } = makeShareSheet([android14, scrolled(android14, 100)]);
    expect(await tool.execute({ action: "select", label: "AutoMobile Share Sink" })).toMatchObject({
      selected: { label: "AutoMobile Share Sink", kind: "app" },
    });
    expect(inputs).toEqual([SWIPE_UP, SWIPE_UP, { args: ["tap", "324", "2085"], displayId: 0 }]);
  });

  test("scrolls back to a first-page match after scanning the rest of the list", async () => {
    const laterPage = renamed(scrolled(android14, 303), "AutoMobile Share Sink", "Photos");
    const { tool, inputs } = makeShareSheet([android14, laterPage]);
    expect(await tool.execute({ action: "select", label: "AutoMobile Share Sink" })).toMatchObject({
      selected: { label: "AutoMobile Share Sink", kind: "app" },
    });
    expect(inputs).toEqual([
      SWIPE_UP,
      SWIPE_UP,
      { args: ["swipe", "540", "1644", "540", "2148", "350"], displayId: 0 },
      { args: ["tap", "324", "2185"], displayId: 0 },
    ]);
  });

  test("reports a missing verified package after the viewport stops changing", async () => {
    const { tool, inputs } = makeShareSheet([android14]);
    await expect(tool.execute({ action: "select", appId: "com.android.chrome" })).rejects.toThrow(
      /No share target matches.*Run shareSheet list/,
    );
    expect(inputs.map(({ args }) => args[0])).toEqual(["swipe"]);
  });

  test("lists a sessionless device read through the connect-only observer capture", async () => {
    const requests: HierarchyCaptureRequest[] = [];
    const tool = new ShareSheet(device, undefined, undefined, () => ({
      async capture(request) {
        requests.push(request);
        const snapshot: HierarchySnapshot = {
          captureId: "observer-read",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy: android14,
          nodes: [],
        };
        return snapshot;
      },
    }));
    const result = await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      tool.execute({ action: "list" }),
    );
    expect(result.sheetKind).toBe("android-intentresolver");
    expect(requests).toEqual([
      { freshness: "fresh", observerMode: true, minTimestamp: undefined, timeoutMs: 3000 },
    ]);
  });

  test("dismisses the sheet with Back", async () => {
    const { tool, inputs } = makeShareSheet([android11]);
    expect(await tool.execute({ action: "dismiss" })).toEqual({
      success: true,
      action: "dismiss",
      sheetKind: "android-legacy",
    });
    expect(inputs).toEqual([{ args: ["keyevent", "KEYCODE_BACK"], displayId: 0 }]);
  });

  test("does not send Back when the sheet is absent", async () => {
    const { tool, inputs } = makeShareSheet([{ ...android11, hierarchy: {} }]);
    await expect(tool.execute({ action: "dismiss" })).rejects.toThrow(/share sheet is not showing/);
    expect(inputs).toEqual([]);
  });

  test("does not recognize a VIEW resolver with chooser-like list identifiers", () => {
    const copy = findNode(
      android11,
      (node) => node["resource-id"] === "android:id/chooser_copy_button",
    );
    copy["resource-id"] = "android:id/button_once";
    try {
      expect(extractAndroidShareSheet(android11, parser)).toBeUndefined();
    } finally {
      copy["resource-id"] = "android:id/chooser_copy_button";
    }
  });

  test("refuses a session-bound watchOS device with platform guidance", async () => {
    const { tool, inputs } = makeShareSheet([], { ...device, platform: "watchos" });
    await expect(tool.execute({ action: "list" })).rejects.toBeInstanceOf(ActionableError);
    await expect(tool.execute({ action: "list" })).rejects.toThrow(/Android.*iOS/);
    expect(inputs).toEqual([]);
  });

  test("rejects an ambiguous selector shape before observing", async () => {
    const { tool } = makeShareSheet([]);
    await expect(
      tool.execute({ action: "select", label: "Copy", appId: "com.example" }),
    ).rejects.toThrow(/exactly one/);
    await expect(tool.execute({ action: "select" })).rejects.toThrow(/exactly one/);
  });

  test("advertises the shared device platforms and rejects unknown actions", () => {
    expect(shareSheetTool.name).toBe("shareSheet");
    expect(shareSheetTool.schema.parse({ action: "list", platform: "android" })).toEqual({
      action: "list",
      platform: "android",
    });
    expect(shareSheetTool.schema.safeParse({ action: "open" }).success).toBe(false);
    for (const platform of ["ios", "tvos", "visionos"]) {
      expect(shareSheetTool.schema.safeParse({ action: "list", platform }).success).toBe(true);
    }
    expect(() => shareSheetTool.schema.parse({ action: "list", platform: "watchos" })).toThrow(
      /shareSheet supports Android and iOS/,
    );
  });
});

test.each(["tvos", "watchos", "visionos"] as const)(
  "refuses a %s request or device with guidance before attempting share sheet I/O",
  async (platform) => {
    const target = { ...device, platform };
    expect(() => assertRequestedPlatformSupported(shareSheetTool.name, { platform })).toThrow(
      /shareSheet supports Android and iOS/,
    );
    expect(() => assertToolSupportsDevicePlatform(shareSheetTool.name, target)).toThrow(
      /shareSheet supports Android and iOS/,
    );
    await expect(new ShareSheet(target).execute({ action: "list" })).rejects.toThrow(
      /Target an Android or iOS device/,
    );
  },
);
