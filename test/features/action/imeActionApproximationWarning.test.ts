import { describe, expect, test } from "bun:test";
import {
  IME_ACTION_APPROXIMATED_WARNING,
  withImeActionApproximationWarning,
} from "../../../src/features/action/imeActionApproximationWarning";

describe("withImeActionApproximationWarning", () => {
  test("adds a warning when the device approximated the action", () => {
    expect(withImeActionApproximationWarning({ success: true, approximated: true })).toEqual({
      success: true,
      approximated: true,
      warning: IME_ACTION_APPROXIMATED_WARNING,
    });
  });

  test("keeps an existing warning", () => {
    const result = withImeActionApproximationWarning({
      success: true,
      approximated: true,
      warning: "earlier",
    });
    expect(result.warning).toBe(`earlier ${IME_ACTION_APPROXIMATED_WARNING}`);
  });

  test("returns the result unchanged when not approximated", () => {
    const result = { success: true };
    expect(withImeActionApproximationWarning(result)).toBe(result);
    const explicit = { success: true, approximated: false };
    expect(withImeActionApproximationWarning(explicit)).toBe(explicit);
  });
});
