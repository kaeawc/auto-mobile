import { describe, expect, test } from "bun:test";
import { appendBounded } from "../../../src/utils/android-cmdline-tools/appendBounded";

describe("appendBounded", () => {
  test("appends unchanged under the limit", () => {
    expect(appendBounded("ab", "cd", 5)).toEqual({ value: "abcd", truncated: false });
  });

  test("does not truncate exactly at the limit", () => {
    expect(appendBounded("ab", "cde", 5)).toEqual({ value: "abcde", truncated: false });
  });

  test("keeps the head when over the limit", () => {
    expect(appendBounded("ab", "cdef", 5)).toEqual({ value: "abcde", truncated: true });
  });

  test("drops further output when already full", () => {
    expect(appendBounded("abcde", "tail", 5)).toEqual({ value: "abcde", truncated: true });
    expect(appendBounded("abcde", "", 5)).toEqual({ value: "abcde", truncated: false });
  });
});
