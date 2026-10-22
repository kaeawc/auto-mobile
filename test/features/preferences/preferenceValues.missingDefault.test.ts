import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { looksLikeMissingIosDefault } from "../../../src/features/preferences/preferenceValues";

const ios27MissingDefault = readFileSync(
  `${import.meta.dir}/../../fixtures/ios-simctl/defaults-delete-absent-key-ios27.txt`,
  "utf8",
);

describe("looksLikeMissingIosDefault", () => {
  test("recognizes the captured iOS 27 absent-key message", () => {
    expect(looksLikeMissingIosDefault(new Error(ios27MissingDefault))).toBe(true);
  });

  test("recognizes the captured iOS 27 absent-key stderr with an empty message", () => {
    expect(
      looksLikeMissingIosDefault(Object.assign(new Error(), { stderr: ios27MissingDefault })),
    ).toBe(true);
  });

  test.each([
    "The domain/default pair of (com.apple.Accessibility, KEY) does not exist",
    "Domain com.apple.Accessibility does not exist.",
    "Domain com.apple.Accessibility not found.",
    "Domain com.apple.Accessibility does not contain KEY.",
    "Domain com.apple.Accessibility does not contain a value for KEY.",
  ])("recognizes legacy wording in message and stderr: %s", (message) => {
    expect(looksLikeMissingIosDefault(new Error(message))).toBe(true);
    expect(looksLikeMissingIosDefault(Object.assign(new Error(), { stderr: message }))).toBe(true);
  });

  test.each(["CoreSimulator connection refused", `${ios27MissingDefault}\nSomething else failed`])(
    "rejects unrelated or trailing failures: %s",
    (message) => {
      expect(looksLikeMissingIosDefault(new Error(message))).toBe(false);
      expect(looksLikeMissingIosDefault(Object.assign(new Error(), { stderr: message }))).toBe(
        false,
      );
    },
  );
});
