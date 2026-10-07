import { describe, expect, test } from "bun:test";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { DefaultTextMatcher } from "../../../src/features/utility/TextMatcher";
import type { ViewHierarchyResult } from "../../../src/models";
import { innerBounds, nestedClickableHierarchy } from "../../fixtures/nestedClickableHierarchy";

// Use real implementations — they're pure and fast
const parser = new DefaultElementParser();
const textMatcher = new DefaultTextMatcher();
const finder = new DefaultElementFinder(parser, textMatcher);
const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function makeHierarchy(nodes: any): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { bounds: bounds(0, 0, 1080, 1920) },
        node: Array.isArray(nodes) ? nodes : [nodes],
      },
    },
  };
}

describe("DefaultElementFinder", () => {
  test("chooses the nearest nested clickable ancestor for a matching label", () => {
    const matches = finder.findClickableParentsContainingText(nestedClickableHierarchy, "Wi-Fi");
    expect(matches.map((match) => match.bounds)).toEqual([innerBounds]);
  });

  test("returns one clickable target when a window root aliases the main hierarchy", () => {
    const row = {
      clickable: true,
      bounds: bounds(0, 0, 200, 80),
      node: [{ text: "Wi-Fi", bounds: bounds(20, 20, 100, 50) }],
    };
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { bounds: bounds(0, 0, 200, 200), node: [row] } },
      windows: [{ windowLayer: 10, hierarchy: { node: [row] } }],
    };

    expect(finder.findClickableParentsContainingText(hierarchy, "Wi-Fi")).toHaveLength(1);
  });

  describe("findElementsByText", () => {
    test("returns empty for null hierarchy", () => {
      expect(finder.findElementsByText(null as any, "Login")).toEqual([]);
    });

    test("returns empty for empty text", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(0, 0, 100, 50) } });
      expect(finder.findElementsByText(hierarchy, "")).toEqual([]);
    });

    test("finds element by text", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(10, 20, 200, 60) } });
      const results = finder.findElementsByText(hierarchy, "Login");
      expect(results).toHaveLength(1);
      expect(results[0].bounds).toEqual({ left: 10, top: 20, right: 200, bottom: 60 });
    });

    test("finds element by content-desc", () => {
      const hierarchy = makeHierarchy({
        $: { "content-desc": "Close button", bounds: { left: 0, top: 0, right: 50, bottom: 50 } },
      });
      const results = finder.findElementsByText(hierarchy, "Close button");
      expect(results).toHaveLength(1);
    });

    test("partial match by default", () => {
      const hierarchy = makeHierarchy({
        $: { text: "Login to Account", bounds: bounds(0, 0, 100, 50) },
      });
      const results = finder.findElementsByText(hierarchy, "Login");
      expect(results).toHaveLength(1);
    });

    test("prefers exact matches over partial", () => {
      const hierarchy = makeHierarchy([
        { $: { text: "Login", bounds: bounds(0, 0, 100, 50) } },
        { $: { text: "Login to Account", bounds: bounds(0, 50, 100, 100) } },
      ]);
      const results = finder.findElementsByText(hierarchy, "Login");
      expect(results).toHaveLength(1);
      // Should return the exact match only
      expect(results[0].bounds.bottom).toBe(50);
    });

    test("tap falls back to a clickable partial row when the only exact match is an input", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "android.widget.EditText",
            text: "Dark",
            clickable: "true",
            bounds: bounds(0, 0, 100, 50),
          },
        },
        {
          $: {
            class: "android.widget.TextView",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      for (const [preserveTraversalOrder, includeWindows] of [
        [false, false],
        [false, true],
        [true, true],
      ]) {
        const results = finder.findElementsByText(
          hierarchy,
          "Dark",
          null,
          true,
          false,
          preserveTraversalOrder,
          includeWindows,
          "tap",
        );
        expect(results.map((element) => element.text)).toEqual(["Dark theme"]);
      }
    });

    test("tap keeps the exact bucket when it contains a clickable non-input target", () => {
      const hierarchy = makeHierarchy([
        { $: { text: "Dark", clickable: "true", bounds: bounds(0, 0, 100, 50) } },
        { $: { text: "Dark theme", clickable: "true", bounds: bounds(0, 50, 100, 100) } },
      ]);

      const results = finder.findElementsByText(
        hierarchy,
        "Dark",
        null,
        true,
        false,
        false,
        true,
        "tap",
      );
      expect(results.map((element) => element.text)).toEqual(["Dark"]);
    });

    test("ranks matching inputs according to explicit selection intent", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "android.widget.EditText",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 0, 100, 50),
          },
        },
        {
          $: {
            class: "android.widget.TextView",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      const focusResults = finder.findElementsByText(
        hierarchy,
        "Dark theme",
        null,
        true,
        false,
        false,
        false,
        "focus-input",
      );
      expect(focusResults).toHaveLength(1);
      expect(focusResults[0].class).toBe("android.widget.EditText");

      const tapResults = finder.findElementsByText(
        hierarchy,
        "Dark theme",
        null,
        true,
        false,
        false,
        false,
        "tap",
      );
      expect(tapResults[0].class).toBe("android.widget.TextView");

      expect(finder.findElementByText(hierarchy, "Dark theme")!.class).toBe(
        "android.widget.EditText",
      );
    });

    test("keeps a non-editable match for input focus when no input matches", () => {
      const hierarchy = makeHierarchy({
        $: {
          class: "android.widget.TextView",
          package: "com.android.systemui",
          text: "Phone notification: ",
          clickable: "true",
          bounds: bounds(0, 0, 100, 50),
        },
      });

      const results = finder.findElementsByText(
        hierarchy,
        "Phone",
        null,
        true,
        false,
        false,
        false,
        "focus-input",
      );
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("Phone notification: ");
      expect(results[0].class).toBe("android.widget.TextView");
    });

    test("uses a partial editable match when the exact match is non-editable", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "android.widget.TextView",
            text: "Phone",
            bounds: bounds(0, 0, 100, 50),
          },
        },
        {
          $: {
            class: "android.widget.EditText",
            text: "Phone number",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      const results = finder.findElementsByText(
        hierarchy,
        "Phone",
        null,
        true,
        false,
        false,
        false,
        "focus-input",
      );
      expect(results).toHaveLength(1);
      expect(results[0].class).toBe("android.widget.EditText");
    });

    test("uses an editable partial match when another window has a non-editable exact match", () => {
      const hierarchy = makeHierarchy([]);
      hierarchy.windows = [
        {
          windowLayer: 2,
          hierarchy: {
            $: { bounds: bounds(0, 0, 100, 100) },
            node: [
              {
                $: {
                  class: "android.widget.TextView",
                  text: "Phone",
                  bounds: bounds(0, 0, 100, 50),
                },
              },
            ],
          },
        },
        {
          windowLayer: 1,
          hierarchy: {
            $: { bounds: bounds(0, 0, 100, 100) },
            node: [
              {
                $: {
                  class: "android.widget.EditText",
                  text: "Phone number",
                  bounds: bounds(0, 50, 100, 100),
                },
              },
            ],
          },
        },
      ];

      const results = finder.findElementsByText(
        hierarchy,
        "Phone",
        null,
        true,
        false,
        false,
        true,
        "focus-input",
      );

      expect(results).toHaveLength(1);
      expect(results[0].class).toBe("android.widget.EditText");
      expect(results[0].text).toBe("Phone number");
    });

    test("demotes custom editable nodes for tap selection", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "com.example.CustomTextField",
            text: "Dark theme",
            "input-type": "text",
            focusable: "true",
            clickable: "true",
            bounds: bounds(0, 0, 10, 10),
          },
        },
        {
          $: {
            class: "android.widget.TextView",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      const results = finder.findElementsByText(
        hierarchy,
        "Dark theme",
        null,
        true,
        false,
        false,
        false,
        "tap",
      );
      expect(results[0].class).toBe("android.widget.TextView");
    });

    test("demotes editable nodes exposing set_text actions for tap selection", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "com.example.MaterialInput",
            text: "Dark theme",
            actions: ["set_text"],
            clickable: "true",
            bounds: bounds(0, 0, 10, 10),
          },
        },
        {
          $: {
            class: "android.widget.TextView",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      const results = finder.findElementsByText(
        hierarchy,
        "Dark theme",
        null,
        true,
        false,
        false,
        false,
        "tap",
      );
      expect(results[0].class).toBe("android.widget.TextView");
    });

    test("keeps the old input ordering when selection intent is omitted", () => {
      const hierarchy = makeHierarchy([
        {
          $: {
            class: "android.widget.EditText",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 0, 100, 50),
          },
        },
        {
          $: {
            class: "android.widget.TextView",
            text: "Dark theme",
            clickable: "true",
            bounds: bounds(0, 50, 100, 100),
          },
        },
      ]);

      expect(finder.findElementByText(hierarchy, "Dark theme")!.class).toBe(
        "android.widget.EditText",
      );
    });

    test("keeps the sole matching text input", () => {
      const hierarchy = makeHierarchy({
        $: {
          class: "android.widget.EditText",
          text: "Dark theme",
          clickable: "true",
          bounds: bounds(0, 0, 100, 50),
        },
      });

      expect(finder.findElementsByText(hierarchy, "Dark theme")).toHaveLength(1);
      expect(finder.findElementByText(hierarchy, "Dark theme")!.class).toBe(
        "android.widget.EditText",
      );
    });

    test("returns empty when container not found", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(0, 0, 100, 50) } });
      const results = finder.findElementsByText(hierarchy, "Login", {
        elementId: "nonexistent-container",
      });
      expect(results).toEqual([]);
    });

    test("searches within container by resource-id", () => {
      const hierarchy = makeHierarchy({
        $: { "resource-id": "my-form", bounds: { left: 0, top: 0, right: 500, bottom: 500 } },
        node: [{ $: { text: "Login", bounds: bounds(10, 10, 200, 50) } }],
      });
      const results = finder.findElementsByText(hierarchy, "Login", { elementId: "my-form" });
      expect(results).toHaveLength(1);
    });

    // Issue #6607: exact/partial bucketing must honor the same caseSensitive
    // flag used to decide the match, otherwise a case-differing exact match is
    // demoted to "partial" and dropped whenever an unrelated exact-case match
    // exists elsewhere in the hierarchy.
    describe("case-insensitive exact bucketing (#6607)", () => {
      const topsOf = (results: { bounds: { top: number } }[]) =>
        results.map((result) => result.bounds.top).sort((a, b) => a - b);

      test("case-differing text is an exact match alongside an exact-case match", () => {
        const hierarchy = makeHierarchy([
          { $: { text: "Delete", bounds: bounds(0, 0, 100, 50) } },
          { $: { text: "DELETE", bounds: bounds(0, 100, 100, 150) } },
          { $: { text: "Delete everything", bounds: bounds(0, 200, 100, 250) } },
        ]);
        const results = finder.findElementsByText(hierarchy, "Delete");
        expect(topsOf(results)).toEqual([0, 100]);
      });

      test("case-differing content-desc is an exact match alongside an exact-case match", () => {
        const hierarchy = makeHierarchy([
          { $: { "content-desc": "Delete", bounds: bounds(0, 0, 100, 50) } },
          { $: { "content-desc": "DELETE", bounds: bounds(0, 100, 100, 150) } },
          { $: { "content-desc": "Delete everything", bounds: bounds(0, 200, 100, 250) } },
        ]);
        const results = finder.findElementsByText(hierarchy, "Delete");
        expect(topsOf(results)).toEqual([0, 100]);
      });

      test("case-differing ios-accessibility-label is an exact match alongside an exact-case match", () => {
        const hierarchy = makeHierarchy([
          { $: { "ios-accessibility-label": "Delete", bounds: bounds(0, 0, 100, 50) } },
          { $: { "ios-accessibility-label": "DELETE", bounds: bounds(0, 100, 100, 150) } },
          {
            $: {
              "ios-accessibility-label": "Delete everything",
              bounds: bounds(0, 200, 100, 250),
            },
          },
        ]);
        const results = finder.findElementsByText(hierarchy, "Delete");
        expect(topsOf(results)).toEqual([0, 100]);
      });

      test("caseSensitive:true still buckets only the exact-case match", () => {
        const hierarchy = makeHierarchy([
          { $: { text: "Delete", bounds: bounds(0, 0, 100, 50) } },
          { $: { text: "DELETE", bounds: bounds(0, 100, 100, 150) } },
          { $: { text: "Delete everything", bounds: bounds(0, 200, 100, 250) } },
        ]);
        const results = finder.findElementsByText(hierarchy, "Delete", null, true, true);
        expect(topsOf(results)).toEqual([0]);
      });
    });
  });

  describe("findElementByText", () => {
    test("returns first match or null", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(0, 0, 100, 50) } });
      expect(finder.findElementByText(hierarchy, "Login")).not.toBeNull();
      expect(finder.findElementByText(hierarchy, "NotFound")).toBeNull();
    });
  });

  describe("findElementsByResourceId", () => {
    test("returns empty for null hierarchy", () => {
      expect(finder.findElementsByResourceId(null as any, "btn_login")).toEqual([]);
    });

    test("finds element by exact resource-id", () => {
      const hierarchy = makeHierarchy({
        $: {
          "resource-id": "com.app:id/btn_login",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      });
      const results = finder.findElementsByResourceId(hierarchy, "com.app:id/btn_login");
      expect(results).toHaveLength(1);
    });

    test("partial match when enabled", () => {
      const hierarchy = makeHierarchy({
        $: {
          "resource-id": "com.app:id/btn_login",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      });
      const results = finder.findElementsByResourceId(hierarchy, "btn_login", null, true);
      expect(results).toHaveLength(1);
    });

    test("no partial match when disabled", () => {
      const hierarchy = makeHierarchy({
        $: {
          "resource-id": "com.app:id/btn_login",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      });
      const results = finder.findElementsByResourceId(hierarchy, "btn_login", null, false);
      expect(results).toHaveLength(0);
    });

    test("matches a bare (Compose testTag) node resource-id against a fully-qualified query", () => {
      // Compose's Modifier.testTag surfaces via viewIdResourceName WITHOUT a package
      // qualifier, unlike traditional View resource IDs. Callers always pass the
      // fully-qualified form (it's what every other element in the hierarchy looks like),
      // so this must match even with partialMatch disabled — it's the node's real ID, not
      // a fuzzy substring hit.
      const hierarchy = makeHierarchy({
        $: {
          "resource-id": "personDetailsSpeedDial_Main",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        },
      });
      const results = finder.findElementsByResourceId(
        hierarchy,
        "com.followupboss.fubandroidstaging:id/personDetailsSpeedDial_Main",
        null,
        false,
      );
      expect(results).toHaveLength(1);
    });
  });

  describe("findElementByResourceId", () => {
    test("returns first match or null", () => {
      const hierarchy = makeHierarchy({
        $: { "resource-id": "btn_login", bounds: { left: 0, top: 0, right: 100, bottom: 50 } },
      });
      expect(finder.findElementByResourceId(hierarchy, "btn_login")).not.toBeNull();
      expect(finder.findElementByResourceId(hierarchy, "btn_signup")).toBeNull();
    });
  });

  describe("findElementsByTestTag", () => {
    test("finds an exact top-level test tag", () => {
      const hierarchy = makeHierarchy({
        $: { "test-tag": "message_row_42", bounds: bounds(0, 0, 100, 50) },
      });

      const results = finder.findElementsByTestTag(hierarchy, "message_row_42");

      expect(results).toHaveLength(1);
      expect(results[0]["test-tag"]).toBe("message_row_42");
    });
  });

  describe("hasContainerElement", () => {
    test("returns false for null hierarchy", () => {
      expect(finder.hasContainerElement(null as any, { text: "test" })).toBe(false);
    });

    test("returns false for null container", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(0, 0, 100, 50) } });
      expect(finder.hasContainerElement(hierarchy, undefined)).toBe(false);
    });

    test("returns true when container found by resource-id", () => {
      const hierarchy = makeHierarchy({
        $: { "resource-id": "my-form", bounds: { left: 0, top: 0, right: 500, bottom: 500 } },
      });
      expect(finder.hasContainerElement(hierarchy, { elementId: "my-form" })).toBe(true);
    });

    test("returns false when container not found", () => {
      const hierarchy = makeHierarchy({ $: { text: "Login", bounds: bounds(0, 0, 100, 50) } });
      expect(finder.hasContainerElement(hierarchy, { elementId: "missing" })).toBe(false);
    });

    test("finds container by text", () => {
      const hierarchy = makeHierarchy({
        $: { text: "Form Section", bounds: bounds(0, 0, 500, 500) },
      });
      expect(finder.hasContainerElement(hierarchy, { text: "Form Section" })).toBe(true);
    });
  });

  describe("findScrollableContainer", () => {
    test("returns null for null hierarchy", () => {
      expect(finder.findScrollableContainer(null as any)).toBeNull();
    });

    test("finds first scrollable container", () => {
      const hierarchy = makeHierarchy({
        $: { scrollable: "true", bounds: bounds(0, 0, 1080, 1920) },
      });
      const result = finder.findScrollableContainer(hierarchy);
      expect(result).not.toBeNull();
    });
  });

  describe("findClickableSiblingsOfResourceId", () => {
    test("returns empty for null hierarchy", () => {
      expect(finder.findClickableSiblingsOfResourceId(null as any, "com.app:id/label")).toEqual([]);
    });

    test("returns empty for empty resourceId", () => {
      const hierarchy = makeHierarchy([]);
      expect(finder.findClickableSiblingsOfResourceId(hierarchy, "")).toEqual([]);
    });

    test("finds clickable sibling of node with matching resource-id", () => {
      const hierarchy = makeHierarchy([
        {
          $: { bounds: bounds(0, 0, 1080, 200) },
          node: [
            {
              $: {
                "resource-id": "com.app:id/label",
                bounds: { left: 0, top: 0, right: 500, bottom: 100 },
              },
            },
            { $: { clickable: "true", bounds: bounds(500, 0, 1080, 100) } },
          ],
        },
      ]);
      const results = finder.findClickableSiblingsOfResourceId(hierarchy, "com.app:id/label");
      expect(results.length).toBe(1);
      expect(results[0].bounds).toEqual({ left: 500, top: 0, right: 1080, bottom: 100 });
    });

    test("does not return the resource-id node itself even if clickable", () => {
      const hierarchy = makeHierarchy([
        {
          $: { bounds: bounds(0, 0, 1080, 200) },
          node: [
            {
              $: {
                "resource-id": "com.app:id/label",
                clickable: "true",
                bounds: { left: 0, top: 0, right: 500, bottom: 100 },
              },
            },
            { $: { clickable: "true", bounds: bounds(500, 0, 1080, 100) } },
          ],
        },
      ]);
      const results = finder.findClickableSiblingsOfResourceId(hierarchy, "com.app:id/label");
      expect(results.length).toBe(1);
      expect(results[0].bounds).toEqual({ left: 500, top: 0, right: 1080, bottom: 100 });
    });

    test("supports partial match", () => {
      const hierarchy = makeHierarchy([
        {
          $: { bounds: bounds(0, 0, 1080, 200) },
          node: [
            {
              $: {
                "resource-id": "com.app:id/label_title",
                bounds: { left: 0, top: 0, right: 500, bottom: 100 },
              },
            },
            { $: { clickable: "true", bounds: bounds(500, 0, 1080, 100) } },
          ],
        },
      ]);
      const results = finder.findClickableSiblingsOfResourceId(
        hierarchy,
        "label_title",
        null,
        true,
      );
      expect(results.length).toBe(1);
    });

    test("returns empty when no sibling has the resource-id", () => {
      const hierarchy = makeHierarchy([
        {
          $: { bounds: bounds(0, 0, 1080, 200) },
          node: [
            {
              $: {
                "resource-id": "com.app:id/other",
                bounds: { left: 0, top: 0, right: 500, bottom: 100 },
              },
            },
            { $: { clickable: "true", bounds: bounds(500, 0, 1080, 100) } },
          ],
        },
      ]);
      const results = finder.findClickableSiblingsOfResourceId(hierarchy, "com.app:id/label");
      expect(results).toEqual([]);
    });

    test("matches a bare (Compose testTag) sibling anchor against a fully-qualified query", () => {
      const hierarchy = makeHierarchy([
        {
          $: { bounds: bounds(0, 0, 1080, 200) },
          node: [
            { $: { "resource-id": "label", bounds: { left: 0, top: 0, right: 500, bottom: 100 } } },
            { $: { clickable: "true", bounds: bounds(500, 0, 1080, 100) } },
          ],
        },
      ]);
      const results = finder.findClickableSiblingsOfResourceId(hierarchy, "com.app:id/label");
      expect(results.length).toBe(1);
      expect(results[0].bounds).toEqual({ left: 500, top: 0, right: 1080, bottom: 100 });
    });
  });
});
