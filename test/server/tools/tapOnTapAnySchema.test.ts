import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { tapOnSchema, tapAnySchema } from "../../../src/server/interactionTools";

// P4 (issue #4181, rank 10): the removed-field rejections used bare
// `.toThrow()`, which passes even when the schema throws for an UNRELATED
// reason. Capture the ZodError and assert exactly WHICH key was rejected via
// the `unrecognized_keys` issue.
function zodIssues(fn: () => unknown): z.core.$ZodIssue[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected the schema to reject the input");
}

function expectRejectedKey(schema: z.ZodType, input: unknown, key: string): void {
  const unrecognized = zodIssues(() => schema.parse(input)).find(
    (issue) => issue.code === "unrecognized_keys",
  ) as { keys?: string[] } | undefined;
  expect(unrecognized, `expected an unrecognized_keys issue for "${key}"`).toBeDefined();
  expect(unrecognized!.keys).toContain(key);
}

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

  test("accepts selector with testTag", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { testTag: "message_row_42" },
    });
    expect(result.selector).toEqual({ testTag: "message_row_42" });
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
      }),
    ).toThrow();
  });

  test("rejects empty textAny selector", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "ios",
        selector: { textAny: [] },
      }),
    ).toThrow();
  });

  test("rejects missing selector", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
      }),
    ).toThrow();
  });

  test("rejects text at top level (old format)", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        text: "Login",
      }),
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
    expect(result.subtext).toBeUndefined();
  });

  test("accepts direct semantic link activation on both platforms", () => {
    const result = tapOnSchema.parse({
      platform: "ios",
      selector: { accessibilityLink: "Terms of Service" },
      index: 1,
    });
    expect(result.selector).toEqual({ accessibilityLink: "Terms of Service" });
    expect(result.index).toBe(1);
  });

  test.each([
    ["non-tap action", { action: "focus" }],
    ["retry", { retryIfNoChange: true }],
    ["ensure", { ensureTap: true }],
    ["searchUntil", { searchUntil: { duration: 500 } }],
  ] as const)("rejects semantic links with %s", (_label, target) => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        ...target,
        selector: { accessibilityLink: "Terms of Service" },
      }),
    ).toThrow();
  });

  test("accepts a container-scoped semantic link and defaults its occurrence", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { elementId: "com.app:id/legal" },
      subtext: { text: "Terms of Service" },
    });
    expect(result.subtext).toEqual({ text: "Terms of Service" });
  });

  test("rejects competing semantic forms and indexed owner-scoped targets", () => {
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { accessibilityLink: "Terms of Service" },
        subtext: { text: "Privacy Policy" },
      }),
    ).toThrow();
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { elementId: "com.app:id/legal" },
        index: 1,
        subtext: { text: "Terms of Service" },
      }),
    ).toThrow();
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

  test.each([
    ["clickable", "moved to tapAny", true],
    ["tapClickableParent", "removed", true],
    ["siblingOfText", "replaced by sibling boolean", "Label"],
  ])("rejects removed field %s (%s) by name", (key, _reason, value) => {
    expectRejectedKey(
      tapOnSchema,
      { platform: "android", selector: { text: "Login" }, [key]: value },
      key,
    );
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

  // The `focus` action is NOT an unrecognized key — it is a recognized field
  // with an invalid enum value, so it surfaces as an `invalid_value` issue on
  // path ["action"], not `unrecognized_keys`. Asserted separately.
  test("rejects the focus action as an invalid value on the action path", () => {
    const actionIssue = zodIssues(() =>
      tapAnySchema.parse({ platform: "android", action: "focus" }),
    ).find((issue) => issue.path[0] === "action");
    expect(actionIssue).toBeDefined();
    expect(actionIssue!.code).toBe("invalid_value");
  });

  test.each([
    ["ensureTap", "not supported", true],
    ["text", "use tapOn instead", "Login"],
    ["elementId", "use tapOn instead", "com.app:id/btn"],
    ["selector", "use tapOn instead", { text: "Login" }],
  ])("rejects removed field %s (%s) by name", (key, _reason, value) => {
    expectRejectedKey(tapAnySchema, { platform: "android", [key]: value }, key);
  });
});
