import { describe, expect, test } from "bun:test";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import {
  androidCoordinateTapRequiresAdbInput,
  androidPackageOfElement,
} from "../../../src/features/action/androidCoordinateTapPolicy";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

function createTapOnElement(): TapOnElement {
  return new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer: new FakeTimer() },
  );
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

describe("androidPackageOfElement", () => {
  test("prefers the explicit package attribute", () => {
    expect(androidPackageOfElement({ package: "com.android.documentsui" } as Element)).toBe(
      "com.android.documentsui",
    );
  });

  test("falls back to the resource-id package prefix", () => {
    expect(
      androidPackageOfElement({ "resource-id": "com.android.documentsui:id/item_root" } as Element),
    ).toBe("com.android.documentsui");
  });

  test("returns undefined when neither package nor resource-id is present", () => {
    expect(androidPackageOfElement({ text: "Download" } as Element)).toBeUndefined();
  });
});

describe("androidCoordinateTapRequiresAdbInput", () => {
  test("flags AOSP DocumentsUI rows", () => {
    expect(
      androidCoordinateTapRequiresAdbInput({
        "resource-id": "com.android.documentsui:id/item_root",
      } as Element),
    ).toBe(true);
  });

  test("flags Google DocumentsUI rows", () => {
    expect(
      androidCoordinateTapRequiresAdbInput({ package: "com.google.android.documentsui" } as Element),
    ).toBe(true);
  });

  test("does not flag ordinary in-app rows", () => {
    expect(
      androidCoordinateTapRequiresAdbInput({
        "resource-id": "com.example.app:id/row",
        clickable: true,
      } as Element),
    ).toBe(false);
  });
});

describe("DocumentsUI row tap-target resolution (#6335)", () => {
  test("resolves the non-clickable title to the actioning item_root row, which requires ADB input", () => {
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

    // And that resolved row must be routed through the real ADB input pipeline.
    expect(androidCoordinateTapRequiresAdbInput(resolved.element)).toBe(true);
  });
});
