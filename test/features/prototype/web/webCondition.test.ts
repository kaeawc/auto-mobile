import { expect, test } from "bun:test";
import { conditionHolds } from "../../../../src/features/prototype/web/webCondition";

const scope = { state: { count: 3, name: "", flag: true }, platform: "android" as const };

test("compares state keys", () => {
  expect(conditionHolds({ key: "flag", equals: true }, scope)).toBe(true);
  expect(conditionHolds({ key: "count", gt: 5 }, scope)).toBe(false);
  expect(conditionHolds({ key: "name", empty: true }, scope)).toBe(true);
});

test("combines with all, any and not", () => {
  expect(
    conditionHolds(
      {
        all: [
          { key: "flag", equals: true },
          { key: "count", lt: 2 },
        ],
      },
      scope,
    ),
  ).toBe(false);
  expect(
    conditionHolds(
      {
        any: [
          { key: "flag", equals: false },
          { key: "count", lt: 4 },
        ],
      },
      scope,
    ),
  ).toBe(true);
  expect(conditionHolds({ not: { key: "flag", equals: true } }, scope)).toBe(false);
});

test("a platform pointer the frame does not decide is undecidable, so the node stays visible", () => {
  expect(conditionHolds({ platform: "/device/widthClass", equals: "expanded" }, scope)).toBe(true);
  const decided = { ...scope, platformState: { "/device/widthClass": "compact" } };
  expect(conditionHolds({ platform: "/device/idiom", equals: "tablet" }, decided)).toBe(true);
});

test("a platform pointer the frame decides compares like state", () => {
  const decided = {
    ...scope,
    platformState: { "/device/widthClass": "compact", "/device/posture": undefined },
  };
  expect(conditionHolds({ platform: "/device/widthClass", equals: "expanded" }, decided)).toBe(
    false,
  );
  expect(conditionHolds({ platform: "/device/widthClass", equals: "compact" }, decided)).toBe(true);
  expect(conditionHolds({ platform: "/device/posture", equals: "book" }, decided)).toBe(false);
  expect(conditionHolds({ platform: "/device/posture", empty: true }, decided)).toBe(true);
  expect(
    conditionHolds({ not: { platform: "/device/widthClass", notEquals: "compact" } }, decided),
  ).toBe(true);
});

test("an undecidable condition stays undecided under not, all and any", () => {
  const unknown = { data: "/x", empty: true };
  expect(conditionHolds({ not: unknown }, scope)).toBe(true);
  expect(conditionHolds({ all: [{ key: "flag", equals: true }, unknown] }, scope)).toBe(true);
  expect(conditionHolds({ all: [{ key: "flag", equals: false }, unknown] }, scope)).toBe(false);
  expect(conditionHolds({ any: [{ key: "flag", equals: false }, unknown] }, scope)).toBe(true);
  expect(conditionHolds({ not: { any: [{ key: "flag", equals: true }, unknown] } }, scope)).toBe(
    false,
  );
});

test("a condition the still cannot decide keeps the node visible", () => {
  expect(conditionHolds({ data: "/feed", empty: true }, scope)).toBe(true);
  expect(conditionHolds({ key: "unknown", equals: 1 }, scope)).toBe(true);
});
