import { describe, expect, test } from "bun:test";
import { BODY_TRUNCATION_LIMIT, truncateBodyText } from "../../src/utils/truncateBodyText";

describe("truncateBodyText", () => {
  test("null stays null", () => {
    expect(truncateBodyText(null)).toBeNull();
  });

  test("body shorter than the limit is returned unchanged", () => {
    const body = "x".repeat(100);
    expect(truncateBodyText(body)).toBe(body);
  });

  test("body exactly at the limit is returned unchanged", () => {
    const body = "x".repeat(BODY_TRUNCATION_LIMIT);
    const result = truncateBodyText(body);
    expect(result).toBe(body);
    expect(result!.length).toBe(BODY_TRUNCATION_LIMIT);
  });

  test("ASCII body over the limit is capped to exactly the limit", () => {
    const body = "x".repeat(20_000);
    expect(truncateBodyText(body)!.length).toBe(BODY_TRUNCATION_LIMIT);
  });

  test("respects a custom limit argument", () => {
    expect(truncateBodyText("abcdef", 3)).toBe("abc");
    expect(truncateBodyText("ab", 3)).toBe("ab");
  });

  test("does not emit a lone surrogate when a pair straddles the boundary", () => {
    // Fill the first LIMIT-1 code units with ASCII, then place a surrogate pair
    // (😀 = U+1F600 = "😀") so its HIGH surrogate lands at index
    // LIMIT-1 and its LOW surrogate at index LIMIT — exactly the mid-pair split.
    const body = "x".repeat(BODY_TRUNCATION_LIMIT - 1) + "😀" + "y".repeat(50);
    const result = truncateBodyText(body)!;

    // The dangling high surrogate is dropped rather than split.
    expect(result.length).toBe(BODY_TRUNCATION_LIMIT - 1);
    // No lone surrogate remains: the string is well-formed UTF-16.
    expect(result.isWellFormed()).toBe(true);
    // Sanity: a naive slice WOULD have left a lone high surrogate.
    expect(body.slice(0, BODY_TRUNCATION_LIMIT).isWellFormed()).toBe(false);
  });

  test("drops a lone low surrogate at the boundary (already-malformed input)", () => {
    // Orphan low surrogate (no preceding high mate) landing at the cut: a naive
    // slice would keep it, leaving the result ill-formed.
    const body = "x".repeat(BODY_TRUNCATION_LIMIT - 1) + "\uDE00" + "y".repeat(50);
    const result = truncateBodyText(body)!;
    expect(result.length).toBe(BODY_TRUNCATION_LIMIT - 1);
    expect(result.isWellFormed()).toBe(true);
  });

  test("limit of 0 or 1 never emits a partial surrogate", () => {
    expect(truncateBodyText("😀tail", 1)).toBe("");
    expect(truncateBodyText("😀tail", 1)!.isWellFormed()).toBe(true);
  });

  test("keeps a whole surrogate pair when the low surrogate is the last kept unit", () => {
    // Pair sits so the LOW surrogate lands at index LIMIT-1 → the whole pair is
    // within the kept range and must be preserved intact.
    const body = "x".repeat(BODY_TRUNCATION_LIMIT - 2) + "😀" + "y".repeat(50);
    const result = truncateBodyText(body)!;
    expect(result.length).toBe(BODY_TRUNCATION_LIMIT);
    expect(result.isWellFormed()).toBe(true);
    expect(result.endsWith("😀")).toBe(true);
  });
});
