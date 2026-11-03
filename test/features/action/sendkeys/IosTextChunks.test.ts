import { expect, test } from "bun:test";
import {
  IOS_TEXT_CHUNK_CODE_POINTS,
  splitIosTextChunks,
} from "../../../../src/features/action/sendkeys/IosTextChunks";

test.each(["", "short", "😀".repeat(IOS_TEXT_CHUNK_CODE_POINTS)])(
  "one chunk is unchanged",
  (text) => expect(splitIosTextChunks(text)).toEqual([text]),
);

test("3500 plain code points greedily pack into four chunks", () => {
  const text = "a".repeat(3500);
  const chunks = splitIosTextChunks(text);
  expect(chunks.map((chunk) => Array.from(chunk).length)).toEqual([1000, 1000, 1000, 500]);
  expect(chunks.join("")).toBe(text);
});

test.each(["👨‍👩‍👧‍👦", "🇺🇸", "e\u0301", "👍🏽", "😀"])(
  "%s remains whole at the code point boundary",
  (grapheme) => {
    const prefix = "a".repeat(IOS_TEXT_CHUNK_CODE_POINTS - 1);
    const suffix = "b".repeat(IOS_TEXT_CHUNK_CODE_POINTS);
    const text = prefix + grapheme + suffix;
    const chunks = splitIosTextChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.some((chunk) => chunk.includes(grapheme))).toBe(true);
    expect(chunks.every((chunk) => Array.from(chunk).length <= IOS_TEXT_CHUNK_CODE_POINTS)).toBe(
      true,
    );
    expect(chunks[0]).toBe(grapheme === "😀" ? prefix + grapheme : prefix);
  },
);

test("a single oversized grapheme is its own chunk", () => {
  const grapheme = "e" + "\u0301".repeat(IOS_TEXT_CHUNK_CODE_POINTS);
  expect(splitIosTextChunks("a" + grapheme + "b")).toEqual(["a", grapheme, "b"]);
});
