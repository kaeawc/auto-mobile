import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { formatToolParamError } from "../../src/server/index";
import { swipeOnSchema, tapOnSchema } from "../../src/server/interactionTools";
import { waitForSchema } from "../../src/server/observeTools";
import { setPreferenceSchema } from "../../src/server/preferenceTools";

// Issue #4181, rank 7 (A6): the "container must be an object …" hint is
// appended only for tapOn/swipeOn when a validation issue lands on the
// `container` path. Currently there is ZERO coverage of the hint text
// ('grep -rn "container must be an object"' -> 0 test hits). These rows pin
// both the presence branch (tapOn/swipeOn) and its absence (every other tool,
// including pinchOn), so adding `|| toolName === "pinchOn"` to index.ts:143
// reds the pinchOn negative row.
const HINT = 'container must be an object like { "elementId": "<id>" }';

function containerError(): z.ZodError {
  // A container-path invalid_type issue, the exact shape produced when a tapOn
  // container is passed a non-object.
  return new z.ZodError([
    {
      code: "invalid_type",
      expected: "object",
      path: ["container"],
      message: "Invalid input: expected object, received string",
    } as unknown as z.core.$ZodIssue,
  ]);
}

describe("formatToolParamError container hint", () => {
  test.each(["tapOn", "swipeOn"])(
    "%s appends the container hint when the container field is invalid",
    (toolName) => {
      expect(formatToolParamError(toolName, containerError())).toContain(HINT);
    },
  );

  test.each(["pinchOn", "dragAndDrop", "observe"])(
    "%s does NOT append the container hint (branch is tapOn/swipeOn only)",
    (toolName) => {
      expect(formatToolParamError(toolName, containerError())).not.toContain(HINT);
    },
  );

  test("tapOn omits the hint when the failing field is not container", () => {
    const err = new z.ZodError([
      {
        code: "invalid_type",
        expected: "string",
        path: ["text"],
        message: "Invalid input: expected string, received number",
      } as unknown as z.core.$ZodIssue,
    ]);
    const message = formatToolParamError("tapOn", err);
    expect(message).not.toContain(HINT);
    expect(message).toContain("text");
  });

  test("non-Zod errors are stringified without a hint", () => {
    expect(formatToolParamError("tapOn", new Error("boom"))).toBe("Error: boom");
  });
});

// Issue #5769: zod v4 rejects non-finite numbers (Infinity/-Infinity/NaN) at the
// base `z.number()` check, so its default `invalid_type` text renders as the
// self-contradictory "<param> expected number, received number" — which reads
// like a bug in the validator. The formatter must name the real constraint.
describe("formatToolParamError non-finite numbers", () => {
  function nonFiniteIssue(path: string[], received: "Infinity" | "NaN" | "number"): z.ZodError {
    // The exact shape zod v4 produces on a number field: `received` is the
    // value-based marker "Infinity" (±Infinity) or "NaN", while the rendered
    // message uses the typeof-based "number"/"NaN". Both markers appear in the
    // wild, so the formatter must recognize each. typeof is still "number", so
    // the default text collapses to "expected number, received number".
    return new z.ZodError([
      {
        code: "invalid_type",
        expected: "number",
        received,
        path,
        message: `Invalid input: expected number, received ${received === "Infinity" ? "number" : received}`,
      } as unknown as z.core.$ZodIssue,
    ]);
  }

  test.each([
    ["returnSpeed", ["returnSpeed"], "Infinity"],
    ["apexPause", ["apexPause"], "NaN"],
    ["nested waitFor.timeoutMs", ["waitFor", "timeoutMs"], "number"],
  ] as const)("names the finite constraint for %s", (_label, path, received) => {
    const message = formatToolParamError("swipeOn", nonFiniteIssue([...path], received));
    expect(message).toBe(`${path.join(".")} must be a finite number`);
    expect(message).not.toContain("expected number, received");
  });

  test("a genuine wrong-type mismatch still reports the type, not the finite constraint", () => {
    // received "string" means the caller passed a string, not a non-finite
    // number — that must keep the type-mismatch message.
    const err = new z.ZodError([
      {
        code: "invalid_type",
        expected: "number",
        received: "string",
        path: ["returnSpeed"],
        message: "Invalid input: expected number, received string",
      } as unknown as z.core.$ZodIssue,
    ]);
    const message = formatToolParamError("swipeOn", err);
    expect(message).toBe("returnSpeed expected number, received string");
    expect(message).not.toContain("finite");
  });

  test.each([Infinity, -Infinity, NaN])(
    "end-to-end: swipeOn returnSpeed = %p is rejected as non-finite",
    (value) => {
      const result = swipeOnSchema.safeParse({
        platform: "android",
        direction: "up",
        returnSpeed: value,
      });
      expect(result.success).toBe(false);
      const message = formatToolParamError("swipeOn", result.error);
      expect(message).toContain("returnSpeed must be a finite number");
    },
  );

  test("end-to-end: tapOn duration = Infinity names the finite constraint", () => {
    const result = tapOnSchema.safeParse({
      platform: "android",
      selector: { text: "Gmail" },
      action: "longPress",
      duration: Infinity,
    });
    expect(result.success).toBe(false);
    expect(formatToolParamError("tapOn", result.error)).toContain(
      "duration must be a finite number",
    );
  });
});

// Issue #5854 §1: `waitForSchema` is a `z.union`, so a single bad field fails
// every branch and `flattenZodIssues` surfaces one fragment per branch — the real
// problem (`timeoutMs must be a finite number`) is buried among ~15
// `expected <T>, received undefined` / `expected never, received …` fragments for
// fields the caller never passed. The formatter must lead with the actionable
// message and drop the union-branch discrimination noise.
describe("formatToolParamError observe union noise (#5854)", () => {
  test("a non-finite waitFor field leads with the finite constraint, no branch dump", () => {
    const result = waitForSchema.safeParse({ timeoutMs: 1e999 } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    expect(message).toBe("timeoutMs must be a finite number");
    expect(message).not.toContain("expected never");
    expect(message).not.toContain("received undefined");
  });

  test("a wrong-type waitFor field leads with the type mismatch, deduplicated", () => {
    const result = waitForSchema.safeParse({ timeoutMs: "abc" } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    expect(message).toBe("timeoutMs expected number, received string");
  });

  test("the actionable message is never repeated once per union branch", () => {
    const result = waitForSchema.safeParse({ timeoutMs: 1e999 } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    const occurrences = message.split("must be a finite number").length - 1;
    expect(occurrences).toBe(1);
  });

  test("with no actionable field, falls back to the full guidance instead of an empty message", () => {
    const result = waitForSchema.safeParse({} as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    expect(message.length).toBeGreaterThan(0);
  });

  // Regression (#5854, PR review): noise suppression must be scoped to issues that
  // actually came from a union branch. `setPreferenceSchema` has top-level enums
  // (`scope`, `type`) beside a union-typed `value`; the union failure must not
  // suppress the sibling enum errors — those are the caller's real mistakes.
  test("a union-typed field does not suppress genuine enum errors on sibling fields", () => {
    const result = setPreferenceSchema.safeParse({
      scope: "bogus",
      key: "k",
      type: "bogus",
      value: {},
    } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("setPreference", result.error);
    // Both top-level enum failures survive alongside the union-valued failures.
    expect(message).toContain("scope Invalid option");
    expect(message).toContain("type Invalid option");
    expect(message).toContain("value expected string");
  });

  // Regression (#5854, PR review): when the whole schema is a `z.union` and a
  // required enum fails in EVERY branch (a shared constraint), it is the caller's
  // real mistake and must survive — the fact that a sibling field also failed
  // must not suppress it via the missing-branch fallback being unavailable.
  test("an enum that fails in every branch of a top-level union is kept", () => {
    const schema = z.union([
      z.object({ id: z.string(), name: z.string(), kind: z.enum(["a", "b"]) }),
      z.object({ id: z.string(), label: z.string(), kind: z.enum(["a", "b"]) }),
    ]);
    // `id` is wrong-typed and `kind` is a bad enum; both are required in both
    // branches, so both are genuine and must appear.
    const result = schema.safeParse({ id: 42, name: "n", kind: "BOGUS" } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("setKeyValue", result.error);
    expect(message).toContain("id expected string, received number");
    expect(message).toContain("kind Invalid option");
  });

  // The complement of the above: an enum that is only required on ONE branch (a
  // discriminator the caller didn't supply) is branch noise and must NOT lead.
  test("a discriminator required on only one branch is suppressed when a real error exists", () => {
    const schema = z.union([
      z.object({ mode: z.enum(["x", "y"]), shared: z.number() }),
      z.object({ shared: z.number() }),
    ]);
    // `shared` is bad in both branches (genuine); `mode` is missing but required
    // only on branch 0 (discrimination noise).
    const result = schema.safeParse({ shared: 1e999 } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    expect(message).toBe("shared must be a finite number");
  });

  // Regression (#5854, PR review): a required field MISSING from every branch of a
  // top-level union is a genuine "you forgot a required field", not branch noise —
  // it must survive alongside another provided-bad field, not be dropped.
  test("a required field missing from every branch is kept", () => {
    const schema = z.union([
      z.object({ id: z.string(), key: z.string(), name: z.string() }),
      z.object({ id: z.string(), key: z.string(), fileName: z.string() }),
    ]);
    // `id` is wrong-typed and `key` is missing; both branches require `key`, so the
    // missing-`key` error is genuine and must appear next to the `id` error.
    const result = schema.safeParse({ id: 42, name: "n" } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("setKeyValue", result.error);
    expect(message).toContain("id expected string, received number");
    expect(message).toContain("key expected string, received undefined");
  });

  // A missing field whose value type is ITSELF a union must not be mistaken for a
  // shared constraint: every arm of the inner type-union reports it missing, which
  // would look "universal" if coverage were measured at the nearest union instead
  // of the outermost discriminating one. `observe`'s `waitFor.activeWindow` is such
  // a field, so a bad `timeoutMs` must still lead alone (#5854).
  test("a missing union-typed predicate is not resurrected as a shared constraint", () => {
    const result = waitForSchema.safeParse({ timeoutMs: 1e999 } as unknown as object);
    expect(result.success).toBe(false);
    const message = formatToolParamError("observe", result.error);
    expect(message).toBe("timeoutMs must be a finite number");
    expect(message).not.toContain("activeWindow");
  });
});
