import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { formatToolParamError } from "../../src/server/index";

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
