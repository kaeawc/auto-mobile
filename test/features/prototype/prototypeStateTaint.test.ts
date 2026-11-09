import { describe, expect, test } from "bun:test";
import {
  stateKeyTaintIndex,
  stateKeysOverlap,
} from "../../../src/features/prototype/prototypeStateTaint";

describe("state key taint matching", () => {
  test.each([
    ["u", "u", true],
    ["u", "user", false],
    ["sel_{index}", "sel_3", true],
    ["sel_3", "sel_{index}", true],
    ["sel_{index}", "other", false],
    ["sel_{index}", "pick_{row.id}", false],
    ["s{index}", "sel_{row.id}", true],
    ["{row.key}", "anything", true],
  ] as const)("%s and %s overlap: %p", (left, right, expected) => {
    expect(stateKeysOverlap(left, right)).toBe(expected);
    expect(stateKeysOverlap(right, left)).toBe(expected);
  });

  test("text matches a tainted key placeholder, not a repeat field of the same name", () => {
    const index = stateKeyTaintIndex(["u", "sel_{index}"], () => true);
    expect(index.text("https://example.com/{u}")).toBe(true);
    expect(index.text("https://example.com/{sel_2}")).toBe(true);
    expect(index.text("https://example.com/{row.u}")).toBe(false);
    expect(index.text("https://example.com/u")).toBe(false);
    expect(index.key("u")).toBe(true);
    expect(index.key("sel_9")).toBe(true);
    expect(index.key("v")).toBe(false);
  });

  test("an exhausted check budget reports no match so the caller fails closed", () => {
    const index = stateKeyTaintIndex(["u"], () => false);
    expect(index.key("u")).toBe(false);
    expect(index.text("{u}")).toBe(false);
  });
});
