import { describe, expect, test } from "bun:test";
import { UIStateExtractor } from "../../../src/features/navigation/UIStateExtractor";
import { ObserveResult } from "../../../src/models";
import type { SwipeOnOptions } from "../../../src/models";
import { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

describe("UIStateExtractor (iOS hierarchy)", () => {
  test("extracts selected elements from $ attributes", () => {
    const viewHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          $: { class: "UITabBar" },
          node: [
            {
              $: {
                text: "Home",
                selected: "true",
                "resource-id": "tab.home",
                "content-desc": "Home tab",
              },
            },
            {
              $: {
                text: "Settings",
                selected: "false",
                "resource-id": "tab.settings",
              },
            },
          ],
        },
      },
    };

    const state = new UIStateExtractor().extract(viewHierarchy);

    expect(state).toBeDefined();
    expect(state?.selectedElements).toHaveLength(1);
    expect(state?.selectedElements[0]).toMatchObject({
      text: "Home",
      resourceId: "tab.home",
      contentDesc: "Home tab",
    });
  });

  test("captures modal stack for iOS alerts", () => {
    const viewHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          $: {
            class: "UIAlertController",
            "resource-id": "alert.main",
            text: "Alert",
            "window-id": "7",
          },
        },
      },
    };

    const state = new UIStateExtractor().extract(viewHierarchy);

    expect(state?.modalStack).toHaveLength(1);
    expect(state?.modalStack?.[0]).toMatchObject({
      type: "dialog",
      identifier: "alert.main",
      layer: 0,
      windowId: 7,
    });
  });

  test("preserves modal stack in extractFromObservation", () => {
    const viewHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          $: {
            class: "UIActionSheet",
            "resource-id": "sheet.main",
          },
        },
      },
      windows: [
        {
          id: 22,
          type: 3,
          hierarchy: {
            $: {
              class: "UIActionSheet",
              "resource-id": "sheet.main",
            },
          },
        },
      ],
    };

    const observation: ObserveResult = {
      updatedAt: 0,
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy,
    };

    const state = new UIStateExtractor().extractFromObservation(observation);

    expect(state?.modalStack).toHaveLength(1);
    expect(state?.modalStack?.[0]).toMatchObject({
      type: "bottomsheet",
      identifier: "sheet.main",
      layer: 0,
      windowId: 22,
      windowType: "3",
    });
  });
});

describe("UIStateExtractor.createScrollPosition", () => {
  function opts(overrides: Partial<SwipeOnOptions>): SwipeOnOptions {
    return { direction: "up", ...overrides } as SwipeOnOptions;
  }

  test("returns undefined when there is no lookFor element search", () => {
    expect(UIStateExtractor.createScrollPosition(opts({ direction: "up" }))).toBeUndefined();
  });

  test("returns undefined when the swipe direction is missing", () => {
    const noDirection = { lookFor: { text: "Save" } } as unknown as SwipeOnOptions;
    expect(UIStateExtractor.createScrollPosition(noDirection)).toBeUndefined();
  });

  test("records the finger direction verbatim for a default finger-gesture scroll", () => {
    const result = UIStateExtractor.createScrollPosition(
      opts({ lookFor: { text: "Save" }, direction: "up" }),
    );
    expect(result?.direction).toBe("up");
    expect(result?.targetElement).toEqual({ text: "Save", resourceId: undefined });
  });

  test("inverts the direction for a scrollTowardsDirection content gesture", () => {
    // Content scrolling "down" is revealed by a finger swipe "up"
    // (SCROLL_TO_FINGER_DIRECTION.down === "up"). A non-inverting mutant that
    // maps down -> down is caught here.
    const result = UIStateExtractor.createScrollPosition(
      opts({
        lookFor: { text: "Save" },
        direction: "down",
        gestureType: "scrollTowardsDirection",
      }),
    );
    expect(result?.direction).toBe("up");
  });

  test("carries the requested scroll speed onto the scroll position", () => {
    const result = UIStateExtractor.createScrollPosition(
      opts({ lookFor: { text: "Save" }, direction: "up", speed: "fast" }),
    );
    expect(result?.speed).toBe("fast");
  });

  test("captures container text and resource id when a container is specified", () => {
    const result = UIStateExtractor.createScrollPosition(
      opts({
        lookFor: { elementId: "id/save" },
        direction: "up",
        container: { text: "List", elementId: "id/list" },
      }),
    );
    expect(result?.targetElement).toEqual({ text: undefined, resourceId: "id/save" });
    expect(result?.container).toEqual({ text: "List", resourceId: "id/list" });
  });

  test("records a target-less scroll position for an empty lookFor", () => {
    const result = UIStateExtractor.createScrollPosition(opts({ lookFor: {}, direction: "up" }));
    expect(result).toBeDefined();
    expect(result?.direction).toBe("up");
    expect(result?.targetElement).toEqual({ text: undefined, resourceId: undefined });
    expect(result?.speed).toBeUndefined();
    expect(result?.container).toBeUndefined();
  });
});
