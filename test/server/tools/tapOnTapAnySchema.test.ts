import { describe, expect, test } from "bun:test";
import { tapOnSchema, tapAnySchema } from "../../../src/server/interactionTools";

describe("tapOn schema", () => {
  test("accepts selector with text", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Login" },
    });
    expect(result.selector).toEqual({ text: "Login" });
    expect(result.action).toBe("tap");
  });

  test("accepts selector with elementId", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { elementId: "com.app:id/btn_login" },
    });
    expect(result.selector).toEqual({ elementId: "com.app:id/btn_login" });
  });

  test("accepts selector with ordered text variants", () => {
    const result = tapOnSchema.parse({
      platform: "ios",
      selector: { textAny: ["Done", "Add"] },
    });
    expect(result.selector).toEqual({ textAny: ["Done", "Add"] });
  });

  test("rejects selector with both text and elementId", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Login", elementId: "com.app:id/btn_login" },
      })
    ).toThrow();
  });

  test("rejects empty textAny selector", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "ios",
        selector: { textAny: [] },
      })
    ).toThrow();
  });

  test("rejects missing selector", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
      })
    ).toThrow();
  });

  test("rejects text at top level (old format)", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        text: "Login",
      })
    ).toThrow();
  });

  test("accepts sibling flag", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Accept Terms" },
      sibling: true,
    });
    expect(result.sibling).toBe(true);
  });

  test("sibling defaults to undefined when omitted", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Login" },
    });
    expect(result.sibling).toBeUndefined();
  });

  test("accepts container", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Item" },
      container: { elementId: "com.app:id/list" },
    });
    expect(result.container).toEqual({ elementId: "com.app:id/list" });
  });

  test("accepts all optional fields", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Submit" },
      sibling: false,
      container: { text: "Form" },
      action: "longPress",
      duration: 2000,
      selectionStrategy: "random",
      index: 1,
      searchUntil: { duration: 3000 },
      preTapStability: true,
      retryIfNoChange: true,
      ensureTap: true,
    });
    expect(result.action).toBe("longPress");
    expect(result.duration).toBe(2000);
    expect(result.index).toBe(1);
    expect(result.preTapStability).toBe(true);
  });

  test("rejects clickable (moved to tapAny)", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Login" },
        clickable: true,
      })
    ).toThrow();
  });

  test("rejects tapClickableParent (removed)", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Login" },
        tapClickableParent: true,
      })
    ).toThrow();
  });

  test("rejects siblingOfText (replaced by sibling boolean)", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Login" },
        siblingOfText: "Label",
      })
    ).toThrow();
  });
});

describe("tapAny schema", () => {
  test("requires only platform", () => {
    const result = tapAnySchema.parse({ platform: "android" });
    expect(result.action).toBe("tap");
  });

  test("accepts selectionStrategy", () => {
    const result = tapAnySchema.parse({
      platform: "android",
      selectionStrategy: "random",
    });
    expect(result.selectionStrategy).toBe("random");
  });

  test("accepts scrollableContainer", () => {
    const result = tapAnySchema.parse({
      platform: "android",
      scrollableContainer: true,
    });
    expect(result.scrollableContainer).toBe(true);
  });

  test("accepts container", () => {
    const result = tapAnySchema.parse({
      platform: "android",
      container: { elementId: "com.app:id/recycler" },
    });
    expect(result.container).toEqual({ elementId: "com.app:id/recycler" });
  });

  test("accepts all optional fields", () => {
    const result = tapAnySchema.parse({
      platform: "android",
      container: { text: "My List" },
      selectionStrategy: "first",
      scrollableContainer: true,
      action: "doubleTap",
      duration: 500,
      searchUntil: { duration: 2000 },
    });
    expect(result.action).toBe("doubleTap");
    expect(result.scrollableContainer).toBe(true);
  });

  test("rejects focus action (use tapOn instead)", () => {
    expect(() =>
      tapAnySchema.parse({
        platform: "android",
        action: "focus",
      })
    ).toThrow();
  });

  test("rejects ensureTap (not supported)", () => {
    expect(() =>
      tapAnySchema.parse({
        platform: "android",
        ensureTap: true,
      })
    ).toThrow();
  });

  test("rejects text field (use tapOn instead)", () => {
    expect(() =>
      tapAnySchema.parse({
        platform: "android",
        text: "Login",
      })
    ).toThrow();
  });

  test("rejects elementId field (use tapOn instead)", () => {
    expect(() =>
      tapAnySchema.parse({
        platform: "android",
        elementId: "com.app:id/btn",
      })
    ).toThrow();
  });

  test("rejects selector field (use tapOn instead)", () => {
    expect(() =>
      tapAnySchema.parse({
        platform: "android",
        selector: { text: "Login" },
      })
    ).toThrow();
  });
});
