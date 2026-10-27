import { expect, test } from "bun:test";
import { satisfiesMinTimestamp } from "../../../../src/features/observe/android/hierarchyFreshness";

test("timestamp floors preserve legacy unknown stamps and reject older numeric trees", () => {
  expect(satisfiesMinTimestamp(9, 10)).toBe(false);
  expect(satisfiesMinTimestamp(10, 10)).toBe(true);
  expect(satisfiesMinTimestamp(11, 10)).toBe(true);
  expect(satisfiesMinTimestamp(undefined, 10)).toBe(true);
  expect(satisfiesMinTimestamp(Number.NaN, 10)).toBe(true);
  expect(satisfiesMinTimestamp(0, 0)).toBe(true);
});
