import { describe, expect, test, spyOn } from "bun:test";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { isAndroidDocumentsUiRow } from "../../../src/features/action/androidCoordinateTapPolicy";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeTimer } from "../../fakes/FakeTimer";

function createTapOnElement(): TapOnElement {
  const clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    {} as AndroidCtrlProxyClient,
  );
  try {
    return new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
      new FakeAdbClient() as any,
      { timer: new FakeTimer() },
    );
  } finally {
    clientSpy.mockRestore();
  }
}

/**
 * A DocumentsUI list row: a clickable `item_root` container whose only textual
 * child (the folder/file name) is NOT itself clickable — matching the real
 * DocumentsUI `item_doc_list` layout where the RecyclerView owns activation.
 */
function documentsUiRowHierarchy(): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        "resource-id": "com.android.documentsui:id/container_directory",
        class: "android.widget.FrameLayout",
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        node: {
          "resource-id": "com.android.documentsui:id/dir_list",
          class: "androidx.recyclerview.widget.RecyclerView",
          scrollable: true,
          bounds: { left: 0, top: 200, right: 1080, bottom: 1900 },
          node: {
            "resource-id": "com.android.documentsui:id/item_root",
            class: "android.widget.LinearLayout",
            clickable: true,
            bounds: { left: 0, top: 300, right: 1080, bottom: 460 },
            node: [
              {
                "resource-id": "com.android.documentsui:id/icon",
                class: "android.widget.FrameLayout",
                clickable: false,
                bounds: { left: 20, top: 320, right: 140, bottom: 440 },
              },
              {
                "resource-id": "android:id/title",
                class: "android.widget.TextView",
                text: "Download",
                clickable: false,
                bounds: { left: 160, top: 350, right: 500, bottom: 410 },
              },
            ],
          },
        },
      },
    },
  } as unknown as ViewHierarchyResult;
}

describe("isAndroidDocumentsUiRow", () => {
  test("flags AOSP DocumentsUI rows", () => {
    expect(
      isAndroidDocumentsUiRow({
        "resource-id": "com.android.documentsui:id/item_root",
      } as Element),
    ).toBe(true);
  });

  test("flags Google DocumentsUI rows", () => {
    expect(
      isAndroidDocumentsUiRow({
        "resource-id": "com.google.android.documentsui:id/item_root",
      } as Element),
    ).toBe(true);
  });

  test("does not flag ordinary in-app rows", () => {
    expect(
      isAndroidDocumentsUiRow({
        "resource-id": "com.example.app:id/row",
        clickable: true,
      } as Element),
    ).toBe(false);
  });
});

describe("DocumentsUI row tap-target resolution (#6335)", () => {
  test("resolves the non-clickable title to the actioning item_root row, which exposes semantic activation", () => {
    const tap = createTapOnElement();
    const title: Element = {
      "resource-id": "android:id/title",
      class: "android.widget.TextView",
      text: "Download",
      clickable: false,
      bounds: { left: 160, top: 350, right: 500, bottom: 410 },
    } as Element;

    const resolved = (tap as any).resolveTapTargetElement(
      title,
      documentsUiRowHierarchy(),
      "tap",
      false,
    ) as { element: Element; usedParent: boolean };

    // The tap must resolve to the clickable row (item_root), not the inert title.
    expect(resolved.usedParent).toBe(true);
    expect(resolved.element["resource-id"]).toBe("com.android.documentsui:id/item_root");

    // The centroid of the resolved row is what will be tapped.
    const center = (tap as any).resolveTapPoint(resolved.element) as { x: number; y: number };
    expect(center).toEqual({ x: 540, y: 380 });

    // And that resolved row must use DocumentsUI row activation/recovery.
    expect(isAndroidDocumentsUiRow(resolved.element)).toBe(true);
  });
});

test("resolves the second repeated row and preserves its preview control", () => {
  const tap = createTapOnElement();
  const first = {
    "resource-id": "com.google.android.documentsui:id/item_root",
    clickable: "true",
    actions: ["click"],
    "collection-row-index": 0,
    "collection-column-index": 0,
    bounds: { left: 0, top: 300, right: 500, bottom: 450 },
    node: { text: "Folder", bounds: { left: 100, top: 320, right: 400, bottom: 420 } },
  };
  const title = {
    "resource-id": "android:id/title",
    text: "example.txt",
    bounds: { left: 100, top: 720, right: 400, bottom: 770 },
  };
  const preview = {
    "resource-id": "com.google.android.documentsui:id/preview_icon",
    clickable: "true",
    actions: ["click"],
    bounds: { left: 400, top: 500, right: 500, bottom: 600 },
  };
  const second = {
    ...first,
    "collection-row-index": 2,
    bounds: { left: 0, top: 500, right: 500, bottom: 800 },
    node: [title, preview],
  };
  const hierarchy = { hierarchy: { node: [first, second] } };
  const resolved = (tap as any).resolveTapTargetElement(title, hierarchy, "tap", false);
  expect(resolved.element["collection-row-index"]).toBe(2);
  expect(resolved.element["collection-column-index"]).toBe(0);
  expect(isAndroidDocumentsUiRow(resolved.element)).toBe(true);
  const resolvedPreview = (tap as any).resolveTapTargetElement(preview, hierarchy, "tap", false);
  expect(resolvedPreview.usedParent).toBe(false);
  expect(isAndroidDocumentsUiRow(resolvedPreview.element)).toBe(false);
});
