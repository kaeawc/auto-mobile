import { describe, expect, test } from "bun:test";
import {
  BASELINE_ACCESSIBILITY_ACTIONS,
  hasInteractionAction,
} from "../../../../src/features/observe/audits/accessibilityActions";

describe("hasInteractionAction", () => {
  test.each(["select", "clear_selection"])("treats standalone %s as interaction", (action) => {
    expect(hasInteractionAction([action])).toBe(true);
    expect(hasInteractionAction([action, "accessibility_focus", "clear_accessibility_focus"])).toBe(
      true,
    );
  });

  test("ignores the paired select/clear_selection baseline signature", () => {
    expect(hasInteractionAction(["select", "clear_selection"])).toBe(false);
    expect(hasInteractionAction(["clear_selection", "select"])).toBe(false);
    expect(hasInteractionAction([...BASELINE_ACCESSIBILITY_ACTIONS])).toBe(false);
  });

  test.each(["accessibility_focus", "clear_accessibility_focus"])(
    "ignores focus bookkeeping action %s",
    (action) => {
      expect(hasInteractionAction([action])).toBe(false);
    },
  );

  test("keeps real actions alongside the paired baseline signature", () => {
    expect(hasInteractionAction(["select", "clear_selection", "click"])).toBe(true);
    expect(hasInteractionAction([])).toBe(false);
  });
});
