import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  tapOnSchema,
  tapAnySchema,
  pinchOnSchema,
  tapOnHandler,
  tapAnyHandler,
  setTapOnElementFactory,
  resetTapOnElementFactory,
  setTapAnyElementFactory,
  resetTapAnyElementFactory,
} from "../../../src/server/interactionTools";

import { selectedElementSchema } from "../../../src/server/toolOutputSchemas";
import { resolverSelectionStrategySchema } from "../../../src/server/elementSelectorSchemas";
import { applyJsonSchemaOverride } from "../../../src/server/toolSchemaHelpers";

import type { TapOnElementOptions, TapAnyElementOptions } from "../../../src/models";

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

  test("accepts ensureChecked for toggle taps", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { text: "Wi-Fi" },
      ensureChecked: true,
    });
    expect(result.ensureChecked).toBe(true);
  });

  test.each([
    ["a non-tap action", true, { action: "longPress" }],
    ["a non-tap action", false, { action: "longPress" }],
    ["random selection", true, { selectionStrategy: "random" }],
    ["random selection", false, { selectionStrategy: "random" }],
  ])("rejects ensureChecked=%s with %s", (_label, ensureChecked, incompatible) => {
    const issue = zodIssues(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Wi-Fi" },
        ensureChecked,
        ...incompatible,
      }),
    ).find((candidate) => candidate.path[0] === "ensureChecked");
    expect(issue).toBeDefined();
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

  test("accepts semantic link activation when ensureChecked is omitted", () => {
    const result = tapOnSchema.parse({
      platform: "android",
      selector: { accessibilityLink: "Terms of Service" },
    });
    expect(result.ensureChecked).toBeUndefined();
  });

  test.each([
    ["non-tap action", { action: "focus" }],
    ["retry", { retryIfNoChange: true }],
    ["ensure", { ensureTap: true }],
    ["ensureChecked", { ensureChecked: true }],
    ["ensureChecked false", { ensureChecked: false }],
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

  test("rejects semantic links with ensureChecked false on the ensureChecked path", () => {
    const issue = zodIssues(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { accessibilityLink: "Terms of Service" },
        ensureChecked: false,
      }),
    ).find((candidate) => candidate.path[0] === "ensureChecked");
    expect(issue).toMatchObject({
      path: ["ensureChecked"],
      message: "semantic link activation cannot ensure checked state",
    });
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
    expect(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { elementId: "com.app:id/legal" },
        selectionStrategy: "random",
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

  // Issue #5769: duration had no lower bound, so a negative longPress duration
  // was accepted and silently degraded into an ordinary tap. It must be rejected
  // with a too_small issue on ["duration"], matching the bounded sibling params.
  test.each([-1, -100000])("rejects negative duration %p", (duration) => {
    const tooSmall = zodIssues(() =>
      tapOnSchema.parse({
        platform: "android",
        selector: { text: "Gmail" },
        action: "longPress",
        duration,
      }),
    ).find((issue) => issue.code === "too_small" && issue.path[0] === "duration");
    expect(tooSmall, "expected a too_small issue on duration").toBeDefined();
    expect(tooSmall!.message).toBe("must be >= 0");
  });

  test("accepts a zero duration (the lower bound is inclusive)", () => {
    expect(
      tapOnSchema.parse({ platform: "android", selector: { text: "Gmail" }, duration: 0 }),
    ).toMatchObject({ duration: 0 });
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

  // Issue #5769: same missing lower bound as tapOn.duration.
  test.each([-1, -100000])("rejects negative duration %p", (duration) => {
    const tooSmall = zodIssues(() =>
      tapAnySchema.parse({ platform: "android", action: "longPress", duration }),
    ).find((issue) => issue.code === "too_small" && issue.path[0] === "duration");
    expect(tooSmall, "expected a too_small issue on duration").toBeDefined();
    expect(tooSmall!.message).toBe("must be >= 0");
  });

  test("accepts a zero duration (the lower bound is inclusive)", () => {
    expect(tapAnySchema.parse({ platform: "android", duration: 0 })).toMatchObject({ duration: 0 });
  });
});

describe("nested tap scopes", () => {
  const container = { elementId: "item_42", container: { elementId: "cart_A", index: 0 } };
  for (const [name, schema, selector] of [
    ["tapOn", tapOnSchema, { selector: { elementId: "remove" } }],
    ["tapAny", tapAnySchema, {}],
  ] as const) {
    test(`${name} accepts nested scopes and unique selection`, () => {
      expect(
        schema.parse({ platform: "android", ...selector, container, selectionStrategy: "unique" }),
      ).toMatchObject({ container, selectionStrategy: "unique" });
    });
    test.each([
      {},
      { elementId: "" },
      { text: "   " },
      { elementId: "cart_A", extra: true },
      { elementId: "cart_A", text: "Cart" },
      { elementId: "cart_A", index: -1 },
    ])(`${name} rejects malformed nested scope %p`, (outer) => {
      expect(
        schema.safeParse({
          platform: "android",
          ...selector,
          container: { elementId: "item_42", container: outer },
        }).success,
      ).toBe(false);
    });
  }
  test("unique supports indexed leaves, ensureChecked and owner subtext", () => {
    for (const options of [{ index: 1 }, { ensureChecked: true }, { subtext: { text: "Terms" } }]) {
      expect(
        tapOnSchema.safeParse({
          platform: "android",
          selector: { elementId: "remove" },
          container,
          selectionStrategy: "unique",
          ...options,
        }).success,
      ).toBe(true);
    }
  });
  test.each([{ sibling: true }, { selector: { accessibilityLink: "Terms" } }])(
    "unique rejects selector paths without leaf cardinality guarantees: %p",
    (options) => {
      expect(
        tapOnSchema.safeParse({
          platform: "android",
          selector: { elementId: "remove" },
          selectionStrategy: "unique",
          ...options,
        }).success,
      ).toBe(false);
    },
  );
});

test("tap JSON schemas retain pinchOn's bounded recursive container definitions", () => {
  const json = (schema: z.ZodType) =>
    z.toJSONSchema(schema, {
      override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
    });
  const pinch = json(pinchOnSchema);
  for (const schema of [tapOnSchema, tapAnySchema]) {
    const output = json(schema);
    expect(output.$defs).toEqual(pinch.$defs);
    expect(output.properties?.container).toMatchObject({ $ref: "#/$defs/__schema0" });
    expect(JSON.stringify(output).length).toBeLessThan(15000);
    expect(output.properties?.selectionStrategy).toMatchObject({
      enum: ["first", "random", "unique"],
    });
  }
});

test("tap result metadata and the canonical strategy enum accept unique", () => {
  expect(selectedElementSchema.parse({ selectionStrategy: "unique" }).selectionStrategy).toBe(
    "unique",
  );
  expect(resolverSelectionStrategySchema.options).toEqual(["first", "random", "unique"]);
});

test("handlers forward the complete nested scope and unique strategy", async () => {
  const requests: (TapOnElementOptions | TapAnyElementOptions)[] = [];
  const execute = async (options: TapOnElementOptions | TapAnyElementOptions) => {
    requests.push(options);
    return {
      success: false,
      action: "tap",
      error: "injected failure",
      element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
    };
  };
  const container = { elementId: "item_42", index: 1, container: { elementId: "cart_A" } };
  const device = { name: "fake", deviceId: "fake", platform: "android" as const };
  setTapOnElementFactory(() => ({ execute }));
  setTapAnyElementFactory(() => ({ execute }));
  try {
    await tapOnHandler(device, {
      action: "tap",
      platform: "android",
      selector: { elementId: "remove" },
      container,
      selectionStrategy: "unique",
    });
    await tapAnyHandler(device, {
      action: "tap",
      platform: "android",
      container,
      selectionStrategy: "unique",
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ container, selectionStrategy: "unique" });
    }
  } finally {
    resetTapOnElementFactory();
    resetTapAnyElementFactory();
  }
});

test("tapAny accepts and forwards display exactly like tapOn", async () => {
  expect(tapAnySchema.parse({ display: "cover" })).toMatchObject({ display: "cover" });
  const requests: TapAnyElementOptions[] = [];
  setTapAnyElementFactory(() => ({
    execute: async (options) => {
      requests.push(options);
      return { success: false, error: "injected failure", element: {} };
    },
  }));
  try {
    const args = { action: "tap" as const, display: "cover" };
    await tapAnyHandler({ name: "fake", deviceId: "fake", platform: "android" }, args);
    expect(requests[0]).toMatchObject({ display: "cover" });
  } finally {
    resetTapAnyElementFactory();
  }
});

for (const error of [
  "No clickable element found",
  "Failed to tap clickable element: No clickable element found",
  undefined,
]) {
  test(`tapAny failure message has one prefix: ${error}`, async () => {
    setTapAnyElementFactory(() => ({
      execute: async () => ({ success: false, error, element: {} }),
    }));
    try {
      const response = await tapAnyHandler(
        { name: "fake", deviceId: "fake", platform: "android" },
        { action: "tap" },
      );
      const payload = JSON.parse(response.content[0].text!);
      expect(payload.message).toBe(
        `Failed to tap clickable element: ${error ? "No clickable element found" : "unknown error"}`,
      );
      expect(payload.error).toBe(error);
      expect(response.isError).toBe(true);
    } finally {
      resetTapAnyElementFactory();
    }
  });
}

for (const key of ["subtext", "accessibilityLink", "focusFirst", "screenReaderNavigation"]) {
  test(`tapAny display does not admit tapOn-only unsupported option ${key}`, () => {
    expectRejectedKey(tapAnySchema, { display: "cover", [key]: true }, key);
  });
}
