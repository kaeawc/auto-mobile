import { expect, test } from "bun:test";
import { resolveTextCtrlProxyTimeoutMs } from "../../../src/features/action/textTransportTimeout";

test.each([
  [0, 5000],
  [1, 5000],
  [5, 5000],
  [300, 32000],
  [1000, 102000],
  [2000, 120000],
])("text transport length %s has timeout %s", (length, expected) => {
  expect(resolveTextCtrlProxyTimeoutMs("a".repeat(length))).toBe(expected);
});

test("counts code points rather than UTF-16 units", () => {
  expect(resolveTextCtrlProxyTimeoutMs("😀".repeat(300))).toBe(32000);
});

test.each([
  [4000, 4000],
  [110000, 102000],
  [0, 0],
  [-1, 0],
])("remaining budget %s clamps to %s", (budget, expected) => {
  expect(resolveTextCtrlProxyTimeoutMs("a".repeat(1000), budget)).toBe(expected);
});
