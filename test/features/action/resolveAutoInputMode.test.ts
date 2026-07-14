import { describe, expect, test } from "bun:test";
import { resolveAutoInputMode } from "../../../src/features/action/resolveAutoInputMode";

describe("resolveAutoInputMode", () => {
  test("returns undefined when no markers are configured (feature off)", () => {
    expect(resolveAutoInputMode("/msg @Nikki Kroll hi", [])).toBeUndefined();
  });

  test("promotes to eventAll when text contains a configured marker", () => {
    expect(resolveAutoInputMode("/msg @Nikki hi", ["@", "/", "#"])).toBe("eventAll");
  });

  test("matches any marker in the list, not just the first", () => {
    expect(resolveAutoInputMode("hello #channel", ["@", "/", "#"])).toBe("eventAll");
  });

  test("returns undefined when no marker is present in the text", () => {
    expect(resolveAutoInputMode("plain message", ["@", "/", "#"])).toBeUndefined();
  });

  test("matches multi-character markers via substring containment", () => {
    expect(resolveAutoInputMode("see https://x.test", ["https://"])).toBe("eventAll");
  });

  test("ignores empty-string markers", () => {
    expect(resolveAutoInputMode("plain", [""])).toBeUndefined();
  });

  test("supports the Slack formatting marker set", () => {
    for (const marker of ["@", "/", "#", ":", "_", "*", "~"]) {
      expect(resolveAutoInputMode(`a${marker}b`, ["@", "/", "#", ":", "_", "*", "~"])).toBe("eventAll");
    }
  });
});
