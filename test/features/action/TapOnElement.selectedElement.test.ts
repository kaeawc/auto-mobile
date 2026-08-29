import { describe, expect, test } from "bun:test";
import type { Element, ElementSelectionResult, TapOnElementResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ResultFaker } from "../../fakes/ResultFaker";

const createTapOnElement = (platform: "android" | "ios" = "android"): TapOnElement => {
  return new TapOnElement(
    {
      name: "test-device",
      platform,
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
    },
  );
};

describe("TapOnElement selectedElement metadata", () => {
  test("rejects a semantic-link owner whose resource ID is shared by another row", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Account B",
      "resource-id": "com.example:id/account_row",
    });
    const duplicateOwner = ResultFaker.element({
      text: "Account A",
      "resource-id": "com.example:id/account_row",
    });
    const hierarchy = {
      hierarchy: {
        node: [
          { ...duplicateOwner, children: [] },
          { ...owner, children: [] },
        ],
      },
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(false);
  });

  test("accepts a semantic-link owner with a unique resource ID", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Account B",
      "resource-id": "com.example:id/account_row_b",
    });
    const hierarchy = {
      hierarchy: {
        node: [{ ...owner, children: [] }],
      },
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(true);
  });

  test("accepts a Compose semantic-link owner identified only by test tag", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Terms and privacy",
      "test-tag": "legal-copy",
    });
    const hierarchy = {
      hierarchy: {
        node: [{ ...owner, children: [] }],
      },
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(true);
  });

  // Regression: the uniqueness count must span window subtrees, because the owner
  // is resolved and natively activated across every window — not just the main
  // hierarchy. Counting only the main tree both mis-passes an ambiguous owner and
  // rejects a valid owner that lives inside a dialog/popup/overlay window (#5618).
  test("rejects an owner duplicated in another window (ambiguous across windows)", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Account B",
      "resource-id": "com.example:id/account_row",
    });
    const duplicateInWindow = ResultFaker.element({
      text: "Account A",
      "resource-id": "com.example:id/account_row",
    });
    const hierarchy = {
      hierarchy: { node: [{ ...owner, children: [] }] },
      windows: [
        {
          isActive: true,
          isFocused: true,
          hierarchy: { node: [{ ...duplicateInWindow, children: [] }] },
        },
      ],
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(false);
  });

  test("accepts a unique owner that lives inside a window subtree", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Terms and privacy",
      "resource-id": "com.example:id/legal_row",
    });
    const hierarchy = {
      hierarchy: { node: [] },
      windows: [
        {
          isActive: true,
          isFocused: true,
          hierarchy: { node: [{ ...owner, children: [] }] },
        },
      ],
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(true);
  });

  test("uses Android's complete stable selector for duplicate resource IDs", () => {
    const tapOnElement = createTapOnElement();
    const owner = ResultFaker.element({
      text: "Account B",
      "resource-id": "com.example:id/account_row",
      "unique-id": "account-row-b",
    });
    const duplicateOwner = ResultFaker.element({
      text: "Account A",
      "resource-id": "com.example:id/account_row",
      "unique-id": "account-row-a",
    });
    const hierarchy = {
      hierarchy: {
        node: [
          { ...duplicateOwner, children: [] },
          { ...owner, children: [] },
        ],
      },
    };

    expect((tapOnElement as any).hasUniqueSemanticLinkOwner(owner, hierarchy)).toBe(true);
  });

  test("reports the actionable dialog button in selected-element metadata", () => {
    const tapOnElement = createTapOnElement("ios");
    const hierarchy = {
      hierarchy: {
        node: {
          $: {
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "XCUIElementTypeWindow",
          },
          node: [
            {
              $: {
                bounds: { left: 10, top: 10, right: 90, bottom: 30 },
                class: "XCUIElementTypeStaticText",
                text: "Sign Out",
                "resource-id": "dialog-title",
              },
            },
          ],
        },
      },
      windows: [
        {
          isActive: true,
          isFocused: true,
          hierarchy: {
            node: {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
                class: "XCUIElementTypeAlert",
              },
              node: [
                {
                  $: {
                    bounds: { left: 10, top: 60, right: 90, bottom: 90 },
                    class: "XCUIElementTypeButton",
                    text: "Sign Out",
                    "resource-id": "dialog-confirm",
                    actions: ["click"],
                  },
                },
              ],
            },
          },
        },
      ],
      screenWidth: 100,
      screenHeight: 100,
    };

    const { selection } = (tapOnElement as any).findElementInHierarchy(
      { text: "Sign Out", action: "tap" },
      hierarchy,
    );
    const selectedElement = (tapOnElement as any).buildSelectedElementMetadata(selection);

    expect(selectedElement.resourceId).toBe("dialog-confirm");
    expect(selectedElement.bounds.centerY).toBe(75);
  });

  test("populates selection metadata and computes bounds centers", () => {
    const tapOnElement = createTapOnElement();
    const element: Element = {
      text: "Sarah's Channel",
      "resource-id": "com.example:id/channel_item",
      class: "android.widget.TextView",
      bounds: { left: 50, top: 200, right: 350, bottom: 280 },
    };
    const selection: ElementSelectionResult = {
      element,
      indexInMatches: 3,
      totalMatches: 10,
      strategy: "random",
    };

    const selectedElement = (tapOnElement as any).buildSelectedElementMetadata(selection);

    expect(selectedElement).toEqual({
      text: "Sarah's Channel",
      resourceId: "com.example:id/channel_item",
      bounds: {
        left: 50,
        top: 200,
        right: 350,
        bottom: 280,
        centerX: 200,
        centerY: 240,
      },
      indexInMatches: 3,
      totalMatches: 10,
      selectionStrategy: "random",
    });
  });

  // A Compose node selected by testTag may carry only a test tag (no text, no
  // resource-id); the metadata must retain it so the tap message can name it.
  test("retains the Compose test tag as selected-element identity", () => {
    const tapOnElement = createTapOnElement();
    const element: Element = {
      "test-tag": "message_row_42",
      class: "android.view.View",
      bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    } as Element;
    const selection: ElementSelectionResult = {
      element,
      indexInMatches: 0,
      totalMatches: 1,
      strategy: "first",
    };

    const selectedElement = (tapOnElement as any).buildSelectedElementMetadata(selection);

    expect(selectedElement.testTag).toBe("message_row_42");
    expect(selectedElement.text).toBe("");
    expect(selectedElement.resourceId).toBe("");
  });

  test("handles text, button, and list item element types", () => {
    const tapOnElement = createTapOnElement();
    const cases: Array<{ label: string; element: Element }> = [
      {
        label: "text",
        element: {
          text: "Channel",
          "resource-id": "com.example:id/channel_text",
          class: "android.widget.TextView",
          bounds: { left: 0, top: 0, right: 100, bottom: 40 },
        },
      },
      {
        label: "button",
        element: {
          text: "Submit",
          "resource-id": "com.example:id/submit_button",
          class: "android.widget.Button",
          bounds: { left: 10, top: 50, right: 210, bottom: 130 },
        },
      },
      {
        label: "list item",
        element: {
          text: "Item 7",
          "resource-id": "com.example:id/list_item",
          class: "android.widget.LinearLayout",
          bounds: { left: 12, top: 140, right: 312, bottom: 220 },
        },
      },
    ];

    for (const entry of cases) {
      const selection: ElementSelectionResult = {
        element: entry.element,
        indexInMatches: 0,
        totalMatches: 1,
        strategy: "first",
      };

      const selectedElement = (tapOnElement as any).buildSelectedElementMetadata(selection);

      expect(selectedElement.text).toBe(entry.element.text);
      expect(selectedElement.resourceId).toBe(entry.element["resource-id"]);
      expect(selectedElement.selectionStrategy).toBe("first");
      expect(selectedElement.totalMatches).toBe(1);
      expect(selectedElement.indexInMatches).toBe(0);
      expect(selectedElement.bounds.centerX).toBe(
        Math.floor((entry.element.bounds.left + entry.element.bounds.right) / 2),
      );
      expect(selectedElement.bounds.centerY).toBe(
        Math.floor((entry.element.bounds.top + entry.element.bounds.bottom) / 2),
      );
    }
  });

  test("tapOn response matches TapOnElementResult interface", () => {
    const element = ResultFaker.element({
      text: "Profile",
      "resource-id": "com.example:id/profile_tab",
      bounds: { left: 0, top: 0, right: 80, bottom: 40 },
    });
    const selectedElement = ResultFaker.tapOnSelectedElement(element, {
      indexInMatches: 1,
      totalMatches: 4,
      selectionStrategy: "random",
    });

    const response: TapOnElementResult = {
      success: true,
      action: "tap",
      element,
      selectedElement,
    };

    expect(response.selectedElement?.selectionStrategy).toBe("random");
    expect(response.selectedElement?.bounds.centerX).toBe(40);
    expect(response.selectedElement?.bounds.centerY).toBe(20);
  });
});
