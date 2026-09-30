import { describe, expect, test } from "bun:test";
import { pressKeyTimeoutMs } from "../../../../src/features/observe/ios/CtrlProxyKeyboard";

describe("pressKeyTimeoutMs", () => {
  test("gives horizontal arrows runner headroom", () => {
    expect(pressKeyTimeoutMs("arrow_left")).toBe(7000);
    expect(pressKeyTimeoutMs("arrow_right")).toBe(7000);
  });

  test("preserves the default for other keys and explicit caller timeouts", () => {
    expect(pressKeyTimeoutMs("enter")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_up")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_down")).toBe(5000);
    expect(pressKeyTimeoutMs("arrow_left", 1200)).toBe(1200);
    expect(pressKeyTimeoutMs("tab", 9000)).toBe(9000);
  });
});
