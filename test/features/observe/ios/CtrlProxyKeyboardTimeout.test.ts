import { describe, expect, test } from "bun:test";
import {
  IOS_ARROW_PRESS_KEY_TIMEOUT_MS,
  IOS_DELETE_PRESS_KEY_TIMEOUT_MS,
  IOS_DEFAULT_PRESS_KEY_TIMEOUT_MS,
  pressKeyTimeoutMs,
} from "../../../../src/features/observe/ios/CtrlProxyKeyboard";

// Mirrors GesturePerformer.arrowBudgetMs; there is no shared protocol budget constant.
const RUNNER_ARROW_BUDGET_MS = 6000;

describe("pressKeyTimeoutMs", () => {
  test("gives horizontal arrows runner headroom", () => {
    expect(IOS_ARROW_PRESS_KEY_TIMEOUT_MS).toBe(9000);
    expect(pressKeyTimeoutMs("arrow_left")).toBe(IOS_ARROW_PRESS_KEY_TIMEOUT_MS);
    expect(pressKeyTimeoutMs("arrow_right")).toBe(IOS_ARROW_PRESS_KEY_TIMEOUT_MS);
  });

  test("gives forward delete headroom for its arrow retry and post-condition poll", () => {
    expect(IOS_DELETE_PRESS_KEY_TIMEOUT_MS).toBe(11000);
    expect(pressKeyTimeoutMs("delete")).toBe(IOS_DELETE_PRESS_KEY_TIMEOUT_MS);
  });

  test("host arrow and delete timeouts exceed the runner arrow budget", () => {
    for (const key of ["arrow_left", "arrow_right", "delete"] as const) {
      expect(pressKeyTimeoutMs(key)).toBeGreaterThan(RUNNER_ARROW_BUDGET_MS);
    }
  });

  test("preserves the default for other keys and explicit caller timeouts", () => {
    expect(pressKeyTimeoutMs("enter")).toBe(5000);
    expect(IOS_DEFAULT_PRESS_KEY_TIMEOUT_MS).toBe(5000);
    expect(pressKeyTimeoutMs("backspace")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_up")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_down")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_left", 1200)).toBe(1200);
    expect(pressKeyTimeoutMs("delete", 1200)).toBe(1200);
    expect(pressKeyTimeoutMs("tab", 9000)).toBe(9000);
  });
});
