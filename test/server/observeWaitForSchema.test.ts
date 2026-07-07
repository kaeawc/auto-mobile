import { describe, expect, test } from "bun:test";
import { DefaultElementFinder } from "../../src/features/utility/ElementFinder";
import type { ViewHierarchyResult } from "../../src/models";
import { findWaitForElement, observeSchema } from "../../src/server/observeTools";

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

const makeHierarchy = (
  nodes: unknown[],
  screenSize = { width: 200, height: 200 }
): ViewHierarchyResult => ({
  hierarchy: {
    node: {
      $: { bounds: bounds(0, 0, screenSize.width, screenSize.height) },
      node: nodes,
    },
  },
  screenWidth: screenSize.width,
  screenHeight: screenSize.height,
});

describe("observeSchema waitFor.container", () => {
  test("accepts elementId waitFor with container elementId", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        elementId: "com.app:id/name",
        timeout: 8000,
        container: { elementId: "com.app:id/list" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      elementId: "com.app:id/name",
      container: { elementId: "com.app:id/list" },
    });
  });

  test("accepts text waitFor with container text", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        text: "Dan Corkill",
        container: { text: "PEOPLE" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      text: "Dan Corkill",
      container: { text: "PEOPLE" },
    });
  });

  test("accepts textAny waitFor with ordered variants", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        textAny: ["Done", "Add"],
        timeout: 8000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      textAny: ["Done", "Add"],
      timeout: 8000,
    });
  });

  test("rejects empty textAny waitFor", () => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor: {
          textAny: [],
        },
      })
    ).toThrow();
  });

  test.each([
    {
      waitFor: { elementId: "com.app:id/name", text: "Name" },
      label: "elementId and text",
    },
    {
      waitFor: { elementId: "com.app:id/name", textAny: ["Name", "Label"] },
      label: "elementId and textAny",
    },
    {
      waitFor: { text: "Name", textAny: ["Name", "Label"] },
      label: "text and textAny",
    },
    {
      waitFor: { elementId: "com.app:id/name", text: "Name", textAny: ["Name", "Label"] },
      label: "elementId, text, and textAny",
    },
  ])("rejects waitFor with mixed selectors: $label", ({ waitFor }) => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor,
      })
    ).toThrow();
  });

  test("rejects container object that includes both elementId and text", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: {
          elementId: "com.app:id/name",
          container: { elementId: "com.app:id/list", text: "extra" },
        },
      })
    ).toThrow();
  });
});

describe("findWaitForElement textAny", () => {
  test("skips off-screen earlier variants when a later variant is visible", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Add", bounds: bounds(20, 20, 120, 70) } },
    ]);

    const element = findWaitForElement(
      finder,
      { textAny: ["Done", "Add"] },
      hierarchy
    );

    expect(element?.text).toBe("Add");
    expect(element?.bounds).toEqual(bounds(20, 20, 120, 70));
  });

  test("returns null when every matched variant is off-screen", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Add", bounds: bounds(220, 20, 320, 70) } },
    ]);

    const element = findWaitForElement(
      finder,
      { textAny: ["Done", "Add"] },
      hierarchy
    );

    expect(element).toBeNull();
  });

  test("checks visible duplicate matches before trying later variants", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Done", bounds: bounds(20, 20, 120, 70) } },
      { $: { text: "Add", bounds: bounds(20, 90, 120, 140) } },
    ]);

    const element = findWaitForElement(
      finder,
      { textAny: ["Done", "Add"] },
      hierarchy
    );

    expect(element?.text).toBe("Done");
    expect(element?.bounds).toEqual(bounds(20, 20, 120, 70));
  });
});
